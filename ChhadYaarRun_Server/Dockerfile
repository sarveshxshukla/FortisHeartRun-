FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY server.js ./
COPY public ./public
ENV PORT=3000 DATA_DIR=/data
EXPOSE 3000
VOLUME ["/data"]
CMD ["node","server.js"]
