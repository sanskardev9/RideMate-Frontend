# RideMate

Mobile-first React/Vite client for group ride safety. The frontend is in `routemate/`; the Node/Express WebSocket backend is a sibling at `../backend/`.

## Setup

```bash
npm install
cp .env.example .env
npm run build
```

Start the API from the repository root in a separate terminal:

```bash
cd backend
cp .env.example .env
npm install
npm run dev
```

Run `backend/sql/001_schema.sql` in the Supabase SQL editor and configure `DATABASE_URL`, `JWT_SECRET`, and `CLIENT_ORIGIN` in `backend/.env`. Then set the frontend's local `routemate/.env`:

```bash
VITE_API_BASE_URL=http://localhost:8080
VITE_WS_BASE_URL=ws://localhost:8080
```

Deploy the `routemate` directory to Vercel and add the `VITE_*` values there. Never put TURN credentials or server secrets in the browser.

## Backend contract

`POST /auth/login` and `POST /auth/register` accept credential JSON and return `{ "access_token", "user" }`. The client sends this bearer token with API requests.

Connect WebSocket to `VITE_WS_BASE_URL/`. Support `location_update` (`userId`, `name`, `latitude`, `longitude`, `accuracy`, `timestamp`, `online`), `chat_message`, `sos_trigger`, and `sos_cancel`. Relay WebRTC signaling messages `call_offer`, `call_answer`, `ice_candidate`, `call_rejected`, and `call_ended`, addressing each with `to`.
