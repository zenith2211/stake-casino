FROM node:20-alpine
WORKDIR /app

# Copy backend deps and install
COPY backend/package*.json ./
RUN npm ci --omit=dev

# Copy backend source files
COPY backend/ .

# Copy frontend into the expected relative location (../../frontend from src/)
# server.js does: path.join(__dirname, '../../frontend')
# __dirname = /app/src, so ../../frontend = /frontend
COPY frontend/ /frontend

EXPOSE 5000
CMD ["node", "src/server.js"]
