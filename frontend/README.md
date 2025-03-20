# GaPP - Job Matching and Social Platform

GaPP is a web application combining job matching, social media, and real-time communication.

## Setup

### Backend
1. Navigate to `backend/`.
2. Install dependencies: `npm install`.
3. Set up `.env` with `MONGO_URI`.
4. Start the server: `npm start`.

### Frontend
1. Navigate to `frontend/`.
2. Install dependencies: `npm install`.
3. Build the app: `npm run build`.

## Deployment on Render
1. Push to GitHub: `https://github.com/Amansimlembe/GaPP3`.
2. Create a Web Service on Render, link to the repo.
3. Set environment variables: `MONGO_URI`, `PORT`.
4. Deploy with `npm install && npm run build && node server.js` as the start command.