export default {
  async fetch(request, env, ctx) {
    return await handleRequest(request, env, ctx)
  }
}

const isAllowNewDevice = false

async function handleRequest(request, env, ctx) {
  const {searchParams, pathname} = new URL(request.url)

  switch(pathname){
    case "/register":{
      return handler.register(env, searchParams)
    }
    case "/ping":{
      return handler.ping(searchParams)
    }
    case "/healthz":{
      return handler.healthz(searchParams)
    }
    case "/info":{
      return handler.info(env, searchParams)
    }
    case "/debug/getClientInfo":{
      return new Response(JSON.stringify(request.cf))
    }
    default:{
      const pathParts = pathname.split('/')
      const deviceKey = pathParts[1]

      // Check whether the URL is invalid
      if(deviceKey.length === 22 && pathParts.length > 2 && pathParts.length < 5){
        return handler.push(env, pathParts, searchParams)
      }

      const Response_Access_Denied = {
        'message': 'Access Denied',
        'code': 500,
        'timestamp': util.getTimestamp(),
      }
      return new Response(JSON.stringify(Response_Access_Denied), {status: Response_Access_Denied.code})
    }
  }
}

/**
 * Class Handler
 */
class Handler {
  constructor(){
    this.version = "v2.0.0"
    this.build = "Oct 23 2023"
    this.arch = "js"
    this.commit = "1"
    this.devices = "0"
  }
  
  async register(env, parameters){
    const db = new Database(env)

    const param_devicetoken = parameters.get('devicetoken')
    let param_key = parameters.get('key')

    let Response_register = {}

    if(!param_devicetoken){
      Response_register = {
        'message': 'device token is empty',
        'code': 400,
        'timestamp': util.getTimestamp(),
      }

      return new Response(JSON.stringify(Response_register), {status: Response_register.code})
    }

    if(!param_key){
      if(isAllowNewDevice){
        param_key = util.newShortUUID()
        await db.saveDeviceTokenByKey(param_key, param_devicetoken)
      }else{
        Response_register = {
          'message': "device registration failed: register disabled",
          'code': 500,
        }

        return new Response(JSON.stringify(Response_register), {status: Response_register.code})
      }
    }

    Response_register = {
      'message': 'success',
      'code': 200,
      'timestamp': util.getTimestamp(),
      'data': {
        'key': param_key,
        'device_key': param_key,
        'device_token': param_devicetoken,
      },
    }

    return new Response(JSON.stringify(Response_register), {status: Response_register.code})
  }

  async ping(parameters){
    const Response_ping = {
      'message': 'pong',
      'code': 200,
      'timestamp': util.getTimestamp(),
    }

    return new Response(JSON.stringify(Response_ping), {status: Response_ping.code})
  }

  async healthz(parameters){
    return new Response("ok")
  }

  async info(env, parameters){
    const db = new Database(env)

    this.devices = await db.countAll()

    const Response_info = {
      'version': this.version,
      'build': this.build,
      'arch': this.arch,
      'commit': this.commit,
      'devices': this.devices,
    }

    return new Response(JSON.stringify(Response_info), {status: 200})
  }

  async push(env, pathParts, parameters){
    const db = new Database(env)

    const deviceToken = await db.deviceTokenByKey(pathParts[1])

    if(!deviceToken){
      const Response_Access_Denied = {
        'message': 'Access Denied',
        'code': 500,
        'timestamp': util.getTimestamp(),
      }
      return new Response(JSON.stringify(Response_Access_Denied), {status: Response_Access_Denied.code})
    }

    let title = ''
    let message = ''

    const apns = new APNs(env)

    if(pathParts.length === 3){
      // Message only
      message = pathParts[2]


    }

    if(pathParts.length === 4){
      // We have a title now
      title = pathParts[2]
      message = pathParts[3]
    }

    return await apns.push(deviceToken, title, message, parameters)
  }
}

const handler = new Handler()

/**
 * Class APNs
 */
class APNs {
  constructor(env){
    const kvStorage = env.database

    // Private Function
    const generateAuthToken = async () => {
      const TOKEN_KEY = `
      -----BEGIN PRIVATE KEY-----
      MIGTAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBHkwdwIBAQQg4vtC3g5L5HgKGJ2+
      T1eA0tOivREvEAY2g+juRXJkYL2gCgYIKoZIzj0DAQehRANCAASmOs3JkSyoGEWZ
      sUGxFs/4pw1rIlSV2IC19M8u3G5kq36upOwyFWj9Gi3Ejc9d3sC7+SHRqXrEAJow
      8/7tRpV+
      -----END PRIVATE KEY-----
      `

      // Parse private key
      const privateKeyPEM = TOKEN_KEY.replace('-----BEGIN PRIVATE KEY-----', '').replace('-----END PRIVATE KEY-----', '').replace(/\s/g, '')
  
      // Decode private key
      const privateKeyArrayBuffer = util.base64ToArrayBuffer(privateKeyPEM)
      const privateKey = await crypto.subtle.importKey('pkcs8',privateKeyArrayBuffer,{name: 'ECDSA',namedCurve: 'P-256',},false,['sign'])
  
      const TEAM_ID = '5U8LBRXG3A'
      const AUTH_KEY_ID = 'LH4T9V5U4R'
    
      // Generate the JWT token
      const JWT_ISSUE_TIME = util.getTimestamp()
      const JWT_HEADER = btoa(JSON.stringify({ alg: 'ES256', kid: AUTH_KEY_ID })).replace('+', '-').replace('/', '_').replace(/=+$/, '')
      const JWT_CLAIMS = btoa(JSON.stringify({ iss: TEAM_ID, iat: JWT_ISSUE_TIME })).replace('+', '-').replace('/', '_').replace(/=+$/, '')
      const JWT_HEADER_CLAIMS = JWT_HEADER + '.' + JWT_CLAIMS
      // Sign
      const jwtArray = new TextEncoder().encode(JWT_HEADER_CLAIMS)
      const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, jwtArray)
      const signatureArray = new Uint8Array(signature)
      const JWT_SIGNED_HEADER_CLAIMS = btoa(String.fromCharCode(...signatureArray)).replace('+', '-').replace('/', '_').replace(/=+$/, '')
      const AUTHENTICATION_TOKEN = JWT_HEADER_CLAIMS + '.' + JWT_SIGNED_HEADER_CLAIMS

      return AUTHENTICATION_TOKEN
    }

    const getAuthToken = async () => {
      let authToken = await kvStorage.get('authToken')
      if(authToken){
        return await authToken
      }
      
      authToken = await generateAuthToken()

      await kvStorage.put('_authToken_', authToken,  {expirationTtl: 3000})

      return authToken

    }

    this.push = async (deviceToken, title, message, parameters) => {
      const TOPIC = 'me.fin.bark'
      const APNS_HOST_NAME = 'api.push.apple.com'
      const AUTHENTICATION_TOKEN = await getAuthToken()
      const pushData = JSON.stringify({
        aps: {
          alert: message,
          'mutable-content': 1,
        },
        // Add other notification parameters as needed
      })
  
      const response = await fetch(`https://${APNS_HOST_NAME}/3/device/${deviceToken}`, {
        method: 'POST',
        headers: {
          'apns-topic': TOPIC,
          'apns-push-type': 'alert',
          'authorization': `bearer ${AUTHENTICATION_TOKEN}`,
          'content-type': 'application/json',
        },
        body: pushData,
      })
  
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      })
    }

  }
}

/**
 * Class Database
 */
class Database {
  constructor(env){
    // Make database private
    const kvStorage = env.database

    this.countAll = async () => {
      const count = (await kvStorage.list()).keys.length
      return count
    }

    this.deviceTokenByKey = async (key) => {
      const deviceToken = await kvStorage.get(key)
      return deviceToken
    }

    this.saveDeviceTokenByKey = async (key, token) => {
      const deviceToken = await kvStorage.put(key, token)
      return await deviceToken
    }
  }
}

// Require env to initialize
// const database = new Database()

/**
 * Class Util
 */
class Util {
  constructor(){}
  getTimestamp(){
    return Math.floor(Date.now() / 1000)
  }

  base64ToArrayBuffer(base64) {
    const binaryString = atob(base64)
    const length = binaryString.length
    const buffer = new Uint8Array(length)
    for (let i = 0; i < length; i++) {
      buffer[i] = binaryString.charCodeAt(i)
    }
    return buffer
  }

  newShortUUID(){
    const characters = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
    const length = 22 //Length of UUID
    let customUUID = ''

    for (let i = 0; i < length; i++) {
      const randomIndex = Math.floor(Math.random() * characters.length)
      customUUID += characters[randomIndex]
    }

    return customUUID
  }
}

const util = new Util()