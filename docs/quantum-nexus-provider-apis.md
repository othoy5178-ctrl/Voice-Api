# Quantum Nexus Provider API Handoff

## Friend List API

Give this URL to the game provider after deploying this backend:

```text
POST https://voice-api-production-703d.up.railway.app/api/friends/list
```

Local testing URL:

```text
POST http://192.168.1.106:5000/api/friends/list
```

## Request

```json
{
  "uid": "MongoDB_USER_ID",
  "token": "AUTH_SESSION_TOKEN",
  "sign": "MD5(uid + token + sharedKey)"
}
```

## Success Response

```json
{
  "errorCode": 0,
  "errorMsg": "Success",
  "data": [
    {
      "uid": "MongoDB_FRIEND_USER_ID",
      "nickname": "Friend Name",
      "avatar": "https://cdn.example.com/avatar.png"
    }
  ]
}
```

## Identity Rules

```text
UID format: MongoDB user _id
Token format: existing Glix auth session token
Friend definition: mutual follow
```

Use MongoDB user `_id` everywhere:

```text
Game SDK userId
Friend list uid
Chat partnerId
Provider message notify sendUID
Provider message notify receiveUID
```

Do not mix `_id` and `glixId`.

## Environment Variables

Add these to Railway/backend environment:

```text
QUANTUM_NEXUS_SHARED_KEY=replace_with_provider_shared_key
QUANTUM_NEXUS_MESSAGE_NOTIFY_URL=https://provider-domain.com/api/message/notify
```

`QUANTUM_NEXUS_MESSAGE_NOTIFY_URL` is optional until the provider gives you their URL.

## Message Notify

When an app user sends a direct message, the backend now calls the provider notify URL if configured.

Request sent to provider:

```json
{
  "sendUID": "MongoDB_SENDER_USER_ID",
  "receiveUID": "MongoDB_RECEIVER_USER_ID",
  "count": 1,
  "sign": "MD5(sendUID + receiveUID + count + sharedKey)"
}
```

## Client Callback

The React Native app is ready for:

```text
openChat(friendUID)
```

But current Android AAR `QuantumNexusSDK-release-1.0.1.aar` does not expose `openChat(friendUID)`.

Ask provider for:

```text
Android AAR with openChat(friendUID) support
clearMessageIndicator(friendUID) API details
Provider message notify API URL
Development and production provider URLs
Shared signing key
Final appId
Final appKey
Final gameId
```
