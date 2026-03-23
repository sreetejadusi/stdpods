FROM node:20

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

# install python for visualization
RUN apt-get update && apt-get install -y python3 gcc

ENV PORT=8080

CMD ["node", "server.js"]