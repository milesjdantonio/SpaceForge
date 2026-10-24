FROM node:22-alpine
RUN npm install --global firebase-tools@15.0.0
WORKDIR /emulator
COPY firebase.json .
RUN chown -R node:node /emulator
USER node
EXPOSE 9099
CMD ["firebase", "emulators:start", "--only", "auth", "--project", "demo-spaceforge", "--config", "/emulator/firebase.json"]
