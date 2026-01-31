/**
 * This is a mock of the steam-user module for testing purposes which makes stdio act like steam chat.
 */


const readline = require('readline');

const messageListeners = [];

module.exports = class {
    constructor() {
        return new Proxy({}, {
            get(obj, prop) {
                switch (prop) {
                    case 'on':
                        return (event, listener) => {
                            switch (event) {
                                case 'friendMessage':
                                    messageListeners.push(listener);
                                    break;
                            }
                        }

                    case 'chatMessage':
                        return (steamID, message) => {
                            console.log(`\n<Chat message to ${typeof steamID === "string"? steamID: steamID.getSteamID64()}>\n${message.split("\n").map(line => "    " + line).join("\n")}\n`);
                        }
                    
                    default:
                        return () => {}
                }
            }
        })
    }
}


class steamID {
    getSteamID64() {
        return '76561199473735104';
    }
}


const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

rl.on('line', (input) => {
    messageListeners.forEach(listener => listener(new steamID, input));
});