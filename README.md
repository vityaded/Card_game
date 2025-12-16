# Card Game (MVP)

## Requirements
- Node.js 18+ (recommended 20+)
- Linux server ok

## Install
```bash
cd card-game
npm install
```

## Run
```bash
PORT=5007 npm start
```

Open:
- Host: `http://<IP>:5007/host.html`

Host flow:
1) Create room
2) Upload A4 image, adjust 8 lines grid, Save
3) Share Player link (shown on host page)
4) Players join, enter name
5) Host presses Start

Notes:
- Rooms are in-memory. If server restarts, active rooms are lost.
- Templates are stored on disk in `server/data/templates/`.
