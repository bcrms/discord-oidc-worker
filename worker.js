import * as config from './config.json'
import { Hono } from 'hono'
import * as jose from 'jose'

const algorithm = {
	name: 'RSASSA-PKCS1-v1_5',
	modulusLength: 2048,
	publicExponent: new Uint8Array([0x01, 0x00, 0x01]),
	hash: { name: 'SHA-256' },
}

const importAlgo = {
	name: 'RSASSA-PKCS1-v1_5',
	hash: { name: 'SHA-256' },
}

async function loadOrGenerateKeyPair(KV) {
	let keyPair = {}
	let keyPairJson = await KV.get('keys', { type: 'json' })

	if (keyPairJson !== null) {
		keyPair.publicKey = await crypto.subtle.importKey('jwk', keyPairJson.publicKey, importAlgo, true, ['verify'])
		keyPair.privateKey = await crypto.subtle.importKey('jwk', keyPairJson.privateKey, importAlgo, true, ['sign'])

		return keyPair
	} else {
		keyPair = await crypto.subtle.generateKey(algorithm, true, ['sign', 'verify'])

		await KV.put('keys', JSON.stringify({
			privateKey: await crypto.subtle.exportKey('jwk', keyPair.privateKey),
			publicKey: await crypto.subtle.exportKey('jwk', keyPair.publicKey)
		}))

		return keyPair
	}

}

const app = new Hono()

app.get('/authorize/:scopemode', async (c) => {

	if (c.req.query('client_id') !== config.clientId
		|| c.req.query('redirect_uri') !== config.redirectURL
		|| !['guilds', 'email'].includes(c.req.param('scopemode'))) {
		return c.text('Bad request.', 400)
	}

	const params = new URLSearchParams({
		'client_id': config.clientId,
		'redirect_uri': config.redirectURL,
		'response_type': 'code',
		'scope': c.req.param('scopemode') == 'guilds' ? 'identify email guilds' : 'identify email',
		'state': c.req.query('state'),
		'prompt': 'none'
	}).toString()

	return c.redirect('https://discord.com/oauth2/authorize?' + params)
})

app.post('/token', async (c) => {
	const body = await c.req.parseBody()
	const code = body['code']
	const params = new URLSearchParams({
		'client_id': config.clientId,
		'client_secret': config.clientSecret,
		'redirect_uri': config.redirectURL,
		'code': code,
		'grant_type': 'authorization_code',
		'scope': 'identify email'
	}).toString()

	const r = await fetch('https://discord.com/api/v10/oauth2/token', {
		method: 'POST',
		body: params,
		headers: {
			'Content-Type': 'application/x-www-form-urlencoded'
		}
	}).then(res => res.json())

	if (r === null) return new Response("Bad request.", { status: 400 })
	const userInfo = await fetch('https://discord.com/api/v10/users/@me', {
		headers: {
			'Authorization': 'Bearer ' + r['access_token']
		}
	}).then(res => res.json())

	if (!userInfo['verified']) return c.text('Bad request.', 400)

	let servers = []

	const serverResp = await fetch('https://discord.com/api/v10/users/@me/guilds', {
		headers: {
			'Authorization': 'Bearer ' + r['access_token']
		}
	})

	if (serverResp.status === 200) {
		const serverJson = await serverResp.json()
		servers = serverJson.map(item => {
			return item['id']
		})
	}

	let roleClaims = {}

	if (c.env.DISCORD_TOKEN && 'serversToCheckRolesFor' in config) {
		await Promise.all(config.serversToCheckRolesFor.map(async guildId => {
			if (servers.includes(guildId)) {
				let memberPromise = fetch(`https://discord.com/api/v10/guilds/${guildId}/members/${userInfo['id']}`, {
					headers: {
						'Authorization': 'Bot ' + c.env.DISCORD_TOKEN
					}
				})
				// i had issues doing this any other way?
				const memberResp = await memberPromise
				const memberJson = await memberResp.json()

				roleClaims[`roles:${guildId}`] = memberJson.roles
			}

		}
		))
	}

	let preferred_username = userInfo['username']

	if (userInfo['discriminator'] && userInfo['discriminator'] !== '0'){
		preferred_username += `_${userInfo['discriminator']}`
	}

	let displayName

	if (userInfo['global_name'] === undefined) {
		displayName = userInfo['username']
	} else {
		displayName = userInfo['global_name']
	}

	let given_name = userInfo['username']

	if (userInfo['discriminator'] && userInfo['discriminator'] !== '0'){
		given_name += `_${userInfo['discriminator']}`
	}

	let nickname = userInfo['username']

	if (userInfo['discriminator'] && userInfo['discriminator'] !== '0'){
		given_name += `_${userInfo['discriminator']}`
	}



	console.log({
		iss: 'https://cloudflare.com',
		aud: config.clientId,
		preferred_username: preferred_username,
		given_name: given_name,
		nickname: nickname,
		sub: userInfo['id'],
		...userInfo,
		...roleClaims,
		email: userInfo['email'],
		global_name: userInfo['global_name'],
		name: displayName,
		guilds: servers
	})

	const idToken = await new jose.SignJWT({
		iss: 'https://cloudflare.com',
		aud: config.clientId,
		preferred_username: preferred_username,
		given_name: given_name,
		family_name: given_name,
		middle_name: given_name,
		nickname: nickname,
		sub: userInfo['id'],
		...userInfo,
		...roleClaims,
		email: "bcrms_" + userInfo['id'] + "@bcrms.dev",
		global_name: userInfo['global_name'],
		name: displayName,
		guilds: servers
	})
		.setProtectedHeader({ alg: 'RS256' })
		.setExpirationTime('1h')
		.setAudience(config.clientId)
		.sign((await loadOrGenerateKeyPair(c.env.KV)).privateKey)

		
	return c.json({
		...r,
		scope: 'identify email',
		id_token: idToken
	})
})

app.get('/jwks.json', async (c) => {
	let publicKey = (await loadOrGenerateKeyPair(c.env.KV)).publicKey
	return c.json({
		keys: [{
			alg: 'RS256',
			kid: 'jwtRS256',
			...(await crypto.subtle.exportKey('jwk', publicKey))
		}]
	})
})

export default app