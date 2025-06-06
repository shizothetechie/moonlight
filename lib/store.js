// @ts-check
import {
	readFileSync,
	writeFileSync,
	existsSync
} from 'fs'
import db from './database.js'
import Connection from './connection.js'

/** @type {typeof import('baileys-elite')} */ // @ts-ignore
const {
	initAuthCreds,
	BufferJSON,
	proto,
	isJidBroadcast,
	isJidGroup,
	WAMessageStubType,
	updateMessageWithReceipt,
	updateMessageWithReaction,
	jidNormalizedUser
} = (await import('baileys-elite')).default

const TIME_TO_DATA_STALE = 5 * 60 * 1000

// TODO: better way to do this?
// Sepparate file for each device?
function makeInMemoryStore() {
	/** @type {{ [jid: string]: { id: string, lastfetch?: number, subject?: string, name?: string, isChats?: boolean, isContact?: boolean, presence?: import('baileys-elite').PresenceData, metadata?: import('baileys-elite').GroupMetadata } & import('baileys-elite').Chat & import('baileys-elite').Contact }}} */
	let chats = {}
	/** @type {{ [jid: string]: import('baileys-elite').proto.WebMessageInfo[] }} */
	let messages = {}
	/** @type {import('baileys-elite').ConnectionState} */
	let state = { connection: 'close' }

	/**
	 * @param {string} jid 
	 * @param {string|null|void} id 
	 * @returns 
	 */
	function loadMessage(jid, id = null) {
		let message = null
		// If only 1 param, first param is assumed to be id not jid
		if (jid && !id) {
			id = jid
			/** @type {(m: import('baileys-elite').proto.WebMessageInfo) => Boolean} */
			const filter = (m) => m.key?.id == id
			const messageFind = Object.entries(messages)
				.find(([, msgs]) => {
					return msgs.find(filter)
				})
			message = messageFind?.[1]?.find(filter)
		} else {
			// @ts-ignore
			jid = jid?.decodeJid?.()
			if (!(jid in messages)) return null;
			message = messages[jid].find(m => m.key.id == id)
		}
		return message ? message : null
	}

	async function getMessage(key) {
		let msg = (await loadMessage(jidNormalizedUser(key.remoteJid), jidNormalizedUser(key.id))).message || {}
	}

	/**
	 * @param {string} jid 
	 * @param {(jid: string) => Promise<import('baileys-elite').GroupMetadata> | null} groupMetadata 
	 */
	async function fetchGroupMetadata(jid, groupMetadata) {
		// @ts-ignore
		jid = jid?.decodeJid?.()
		if (!isJidGroup(jid)) return
		if (!(jid in chats)) return chats[jid] = { id: jid }
		const isRequiredToUpdate = !chats[jid].metadata || Date.now() - (chats[jid].lastfetch || 0) > TIME_TO_DATA_STALE
		if (isRequiredToUpdate) {
			const metadata = await groupMetadata?.(jid)
			if (metadata) Object.assign(chats[jid], {
				subject: metadata.subject,
				lastfetch: Date.now(),
				metadata
			})
		}
		return chats[jid].metadata
	}

	/** @param {string} id */
	function fetchMessageReceipts(id) {
		const msg = loadMessage(id)
		if (!msg) return null
		return msg.userReceipt
	}

	/**
	 * @param {string} jid 
	 * @param {(jid: string, type?: 'preview' | 'image', timeoutMs?: number) => Promise<string>} profilePictureUrl 
	 */
	async function fetchImageUrl(jid, profilePictureUrl) {
		// @ts-ignore
		jid = jid?.decodeJid?.()
		if (!(jid in chats)) return chats[jid] = { id: jid }
		if (!chats[jid].imgUrl) {
			const url = await profilePictureUrl(jid, 'image').catch(() => './src/avatar_contact.png')
			if (url) chats[jid].imgUrl = url
		}
		return chats[jid].imgUrl
	}

	/**
	 * @param {string} jid 
	 */
	function getContact(jid) {
		// @ts-ignore
		jid = jid?.decodeJid?.()
		if (!(jid in chats)) return null
		return chats[jid]
	}

	/**
	 * @param {string} jid 
	 * @param {import('baileys-elite').proto.WebMessageInfo} message 
	 */
	const upsertMessage = (jid, message, type = 'append') => {
		// @ts-ignore
		jid = jid?.decodeJid?.()
		if (!(jid in messages)) messages[jid] = []

		// Clean message
		delete message.message?.messageContextInfo
		delete message.message?.senderKeyDistributionMessage

		const msg = loadMessage(jid, message.key.id)
		if (msg) {
			Object.assign(msg, message)
		} else {
			if (type == 'append') messages[jid].push(message)
			else messages[jid].splice(0, 0, message)
		}
	}

	/** 
	 * @param {import('baileys-elite').BaileysEventEmitter} ev 
	 * @param {{ groupMetadata: (jid: string, minimal?: boolean) => Promise<import('baileys-elite').GroupMetadata> | null }} opts
	 */
	function bind(ev, opts = { groupMetadata: () => null }) {
		ev.on('connection.update', update => {
			Object.assign(state, update)
		})

		ev.on('chats.set', function store(chatsSet) {
			// const { isLatest } = chatsSet
			// if (isLatest) chats = {}
			for (const chat of chatsSet.chats) {
				// @ts-ignore
				const id = chat.id?.decodeJid?.()
				if (!id) continue
				// @ts-ignore
				if (!(id in chats)) chats[id] = { ...chat, isChats: true, ...(chat.name ? { name: /** @type {String} */ (chat.name) } : {}) }
				if (chat.name) chats[id].name = chat.name
			}
		})

		ev.on('contacts.set', function store(contactsSet) {
			for (const contact of contactsSet.contacts) {
				// @ts-ignore
				const id = contact.id?.decodeJid?.()
				if (!id) continue
				chats[id] = Object.assign(chats[id] || {}, { ...contact, isContact: true })
			}
		})

		ev.on('messages.set', function store(messagesSet) {
			// const { isLatest } = messagesSet
			// if (isLatest) messages = {}
			for (const message of messagesSet.messages) {
				// @ts-ignore
				const jid = message.key.remoteJid?.decodeJid?.()
				if (!jid) continue
				if (!jid || isJidBroadcast(jid)) continue
				if (!(jid in messages)) messages[jid] = []
				const id = message.key.id
				const msg = loadMessage(jid, id)
				// if (msg) console.log(`duplicate message ${id} ('message.set')`)
				upsertMessage(jid, proto.WebMessageInfo.fromObject(message), 'prepend')
			}
		})

		ev.on('call', async (call) => {
			if (call[0].status == 'offer' && db.data.datas.anticall) await Connection.conn.rejectCall(call[0].id, call[0].from)
		})

		ev.on('contacts.update', function store(contactsUpdate) {
			for (const contact of contactsUpdate) {
				// @ts-ignore
				const id = contact.id?.decodeJid?.()
				if (!id) continue
				chats[id] = Object.assign(chats[id] || {}, { id, ...contact, isContact: true })
			}
		})

		ev.on('chats.upsert', async function store(chatsUpsert) {
			await Promise.all(chatsUpsert.map(async (chat) => {
				// @ts-ignore
				const id = chat.id?.decodeJid?.()
				if (!id || isJidBroadcast(id)) return
				// @ts-ignore
				if (!(id in chats)) chats[id] = { id, ...chat, isChats: true }
				const isGroup = isJidGroup(id)
				Object.assign(chats[id], { ...chat, isChats: true })
				if (isGroup && !chats[id].metadata) Object.assign(chats[id], { metadata: await fetchGroupMetadata(id, opts.groupMetadata) })
			}))
		})

		ev.on('chats.update', function store(chatsUpdate) {
			for (const chat of chatsUpdate) {
				// @ts-ignore
				const id = chat.id?.decodeJid?.()
				if (!id) continue
				// @ts-ignore
				if (!(id in chats)) chats[id] = { id, ...chat, isChats: true }
				if (chat.unreadCount) chat.unreadCount += chats[id].unreadCount || 0
				Object.assign(chats[id], { id, ...chat, isChats: true })
			}
		})

		ev.on('presence.update', function store(presenceUpdate) {
			// @ts-ignore
			const id = presenceUpdate.id?.decodeJid?.()
			if (!id) return
			if (!(id in chats)) chats[id] = { id, isContact: true }
			Object.assign(chats[id], presenceUpdate)
		})

		ev.on('messages.upsert', function store(messagesUpsert) {
			const { messages: newMessages, type } = messagesUpsert
			switch (type) {
				case 'append':
				case 'notify':
					for (const msg of newMessages) {
						// @ts-ignore
						const jid = msg.key.remoteJid?.decodeJid?.()
						if (!jid || isJidBroadcast(jid)) continue

						if (msg.messageStubType == WAMessageStubType.CIPHERTEXT) continue
						if (!(jid in messages)) messages[jid] = []
						const message = loadMessage(jid, msg.key.id)
						// if (message) console.log(`duplicate message ${msg.key.id} ('messages.upsert')`)
						upsertMessage(jid, proto.WebMessageInfo.fromObject(msg))

						if (type === 'notify' && !(jid in chats))
							ev.emit('chats.upsert', [{
								id: jid,
								conversationTimestamp: msg.messageTimestamp,
								unreadCount: 1,
								name: msg.pushName || msg.verifiedBizName,
							}])
					}
					break
			}
		})

		ev.on('messages.update', async function store(messagesUpdate) {
			for (const message of messagesUpdate) {
				// @ts-ignore
				const jid = message.key.remoteJid?.decodeJid?.()
				if (!jid) continue
				const id = message.key.id
				if (!jid || isJidBroadcast(jid)) continue
				if (!(jid in messages)) messages[jid] = []
				const msg = loadMessage(jid, id)
				if (!msg) return // console.log(`missing message ${id} ('messages.update')`)
				if (message.update.messageStubType == WAMessageStubType.REVOKE) {
					// Fix auto delete because if the message is deleted, the message is removed and feature antidelete need that message to be in the database
					// console.log(`revoke message ${id} ('messages.update')`, message)
					continue
				}
				// @ts-ignore
				const msgIndex = messages[jid].findIndex(m => m.key.id === id)
				Object.assign(messages[jid][msgIndex], message.update)
				// console.debug(`updated message ${id} ('messages.update')`, message.update)
			}
		})

		ev.on('groups.update', async function store(groupsUpdate) {
			await Promise.all(groupsUpdate.map(async (group) => {
				// @ts-ignore
				const id = group.id?.decodeJid?.()
				if (!id) return
				const isGroup = isJidGroup(id)
				if (!isGroup) return
				if (!(id in chats)) chats[id] = { id, ...group, isChats: true }
				if (!chats[id].metadata) Object.assign(chats[id], { metadata: await fetchGroupMetadata(id, opts.groupMetadata) })
				// @ts-ignore
				Object.assign(chats[id].metadata, group)
			}))
		})

		ev.on('group-participants.update', async function store(groupParticipantsUpdate) {
			// @ts-ignore
			const id = groupParticipantsUpdate.id?.decodeJid?.()
			if (!id || !isJidGroup(id)) return
			if (!(id in chats)) chats[id] = { id }
			if (!(id in chats) || !chats[id].metadata) Object.assign(chats[id], { metadata: await fetchGroupMetadata(id, opts.groupMetadata) })
			const metadata = chats[id].metadata
			if (!metadata) return console.log(`Try to update group ${id} but metadata not found in 'group-participants.update'`)
			switch (groupParticipantsUpdate.action) {
				case 'add':
					metadata.participants.push(...groupParticipantsUpdate.participants.map(id => ({ id, admin: null })))
					break
				case 'demote':
				case 'promote':
					for (const participant of metadata.participants)
						if (groupParticipantsUpdate.participants.includes(participant.id))
							participant.admin = groupParticipantsUpdate.action === 'promote' ? 'admin' : null

					break
				case 'remove':
					metadata.participants = metadata.participants.filter(p => !groupParticipantsUpdate.participants.includes(p.id))
					break
			}

			Object.assign(chats[id], { metadata })
		})

		ev.on('message-receipt.update', function store(messageReceiptUpdate) {
			for (const { key, receipt } of messageReceiptUpdate) {
				// @ts-ignore
				const jid = key.remoteJid?.decodeJid?.()
				if (!jid) continue
				const id = key.id
				if (!(jid in messages)) messages[jid] = []
				const msg = loadMessage(jid, id)
				if (!msg) return // console.log(`missing message ${id} ('message-receipt.update')`)
				updateMessageWithReceipt(msg, receipt)
			}
		})

		ev.on('messages.reaction', function store(reactions) {
			for (const { key, reaction } of reactions) {
				// @ts-ignore
				const jid = key.remoteJid?.decodeJid?.()
				if (!jid) continue
				const msg = loadMessage(jid, key.id)
				if (!msg) return // console.log(`missing message ${key.id} ('messages.reaction')`)
				updateMessageWithReaction(msg, reaction)
			}
		})

	}

	function toJSON() {
		return { chats, messages }
	}

	function fromJSON(json) {
		Object.assign(chats, json.chats)
		for (const jid in json.messages)
			messages[jid] = json.messages[jid].map(m => m && proto.WebMessageInfo.fromObject(m)).filter(m => m && m.messageStubType != WAMessageStubType.CIPHERTEXT)

	}

	/** @param {string} path  */
	function writeToFile(path) {
		writeFileSync(path, JSON.stringify(toJSON(), (key, value) => key == 'isChats' ? undefined : value, 2))
	}

	/** @param {string} path  */
	function readFromFile(path) {
		if (existsSync(path)) {
			const result = JSON.parse(readFileSync(path, { encoding: 'utf-8' }))
			fromJSON(result)
		}
	}

	return {
		chats,
		messages,
		state,

		loadMessage,
		fetchGroupMetadata,
		fetchMessageReceipts,
		fetchImageUrl,

		getContact,

		bind,
		writeToFile,
		readFromFile
	}
}

function JSONreplacer(key, value) {
	if (value == null) return
	const baileysJSON = BufferJSON.replacer(key, value)
	return baileysJSON
}

const fixFileName = (file) => file?.replace(/\//g, '__')?.replace(/:/g, '-')

export default {
	makeInMemoryStore,
	fixFileName,
	JSONreplacer
}
