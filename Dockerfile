# Use official Node.js image (updated to current LTS)
FROM node:24-alpine

# Set working directory inside container
WORKDIR /app

# Copy package.json and package-lock.json
COPY package*.json ./

# Install dependencies
RUN npm install --production

# Copy source code
COPY src ./src

# Create directory for SQLite database
RUN mkdir -p /app/data

# Hocuspocus server listens on port 8080 by default
EXPOSE 8080

# Command to start the server
CMD [ "npm", "start" ]