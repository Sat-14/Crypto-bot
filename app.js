/*
    Modules
*/

const fs = require("fs");

const config = fs.existsSync("./.config/config.js")? require("./.config/config.js"): require('./config.js');

const uws = require('uWebSockets.js');
const { MongoClient } = require('mongodb');

const mongo_client = new MongoClient(config.db.uri);

const SteamTotp = require('steam-totp');
const SteamCommunity = require('steamcommunity');
const TradeOfferManager = require('steam-tradeoffer-manager');

const AbstractPaymentProcessor = require('./js/payments');
const profileExtractor = require('./js/steam-profile-extract');
const SteamUser = config.testMode
    ? require('./js/testmode/steam-user')
    : require('steam-user');

const default_prices = {
    "buy": config.price?.buy || 1.66,
    "sell": config.price?.sell || 1.5,
    "max": config.price?.max || 100,
    "fee": config.price?.fee || 0.7,
    "minimum_order": config.price?.minimum_order || 10,
}

let Currencies = require('./data/currencies.json');
let Prices = fs.existsSync("./data/prices.json")? require('./data/prices.json'): (fs.writeFileSync("./data/prices.json", JSON.stringify(default_prices)), default_prices);
let Banlist = fs.existsSync("./data/banlist.json")? require('./data/banlist.json'): (fs.writeFileSync("./data/banlist.json", JSON.stringify({})), {});


// Modules for the website
const jwt = require('jsonwebtoken');
const website = require('./js/website');
const jwtSecret = config.http.jwt_secret;
const crypto = require('crypto');


let db = mongo_client.db(config.db.dbName),
    usersCollection = db.collection("users"),
    client = new SteamUser(),
    community = new SteamCommunity(),

    transactions = new Map(),
    userTransactionLock = new Map(),

    reservedItems = new Set(), 

    app = config.http.ssl? new uws.SSLApp({
        key_file_name: config.http.key,
        cert_file_name: config.http.cert,
    }): new uws.App(),

    cache = {
        stock: []
    }
;

/*
    Load configuration
*/

config.admin.activated = new Set;
config.http.server_url = `http${config.http.ssl? "s": ""}://${config.http.domain}:${config.http.port}/`;

const manager = new TradeOfferManager({
    steam: client,
    community
});

async function increaseBalanceOf(steamID_64, value) {
    // If value is positive, subtract 0.01 from it
    const adjustedValue = value ;
    
    const { balance } = await usersCollection.findOneAndUpdate(
        { steamID: steamID_64 },
        { $inc: { balance: Number(adjustedValue) || 0 } },
        {
            returnDocument: "after",
            projection: { balance: 1, _id: 0 }
        }
    );

    ws_publish(steamID_64, {
        type: "patch",
        user: { balance }
    })

    return balance
}

function ws_publish(steamID_64, data) {
    app.publish(steamID_64, JSON.stringify(data), false)
}

const { payments, PAYMENT_PROCESSORS } = AbstractPaymentProcessor(config, {
    client,
    userTransactionLock,
    transactions,
    increaseBalanceOf,
    ws_publish,
    db,

    // Process a Binance deposit (from transaction logs)
    // processDeposit(steamID_64, amount, transactionId) {
    //     getUser(steamID_64);
    //     increaseBalanceOf(steamID_64, amount);
    // },
}, Currencies, Prices);


if(!jwtSecret || jwtSecret.length < 10) {
    payments.sendError("Warning: JWT secret is not set or too weak - please set it in the config file.");
    process.exit(1);
}


/*
    Helper functions
*/

async function getUser(steamID) {
    const steamID_64 = typeof steamID === "string" ? steamID : steamID.getSteamID64();

    const user = await usersCollection.findOne({ steamID: steamID_64 });

    if (!user) {
        const user = {
            steamID: steamID_64,
            balance: 0
        };

        await usersCollection.insertOne(user);

        payments.sendNotification(`Added ${steamID_64} to the database with a balance of 0$.`);
        return user
    }

    return user;
}
async function findTransactionByBatchWithdrawalId(batchId) {
    return await db.collection('transactions').findOne({
        type: "withdrawal",
        batch_withdrawal_id: batchId
    });
}


function reserveKeys(keys, amount) {
    const reserved = [];

    for (let i = 0; reserved.length < amount; i++) {
        if (i >= keys.length) {
            // Not enough keys available
            break;
        }

        const id = keys[i].assetid;

        if (reservedItems.has(id)) {
            // This key is already reserved, skip it
            continue;
        }

        reserved.push(id);
        reservedItems.add(id);
    }

    return reserved
}

function releaseKeys(reservedKeys) {
    for (const key of reservedKeys) {
        reservedItems.delete(key);
    }
}


function updatePersona(){
    client.setPersona(SteamUser.EPersonaState.Online);
    client.gamesPlayed(`[S: ${Prices.buy}] [B: ${Prices.sell}] [Keys: ${cache.stockCount}/${Prices.max}]`);
}



/**
 * Create a buy keys transaction
 */

async function createBuyOffer({ callback = null, steamID_64, tradeLink, keys, amount, paid_via_crypto, reservedKeys, steamChat = true, responseWrapper=null}) {
    if(typeof steamID_64 === "object") {
        steamID_64 = steamID_64.getSteamID64();
    }

    let offer = manager.createOffer(tradeLink? tradeLink: steamID_64);
    offer.setMessage("Buy Mann Co. Supply Crate Keys.");

    let added_amount = 0;
    for (let key of keys) {
        if (!reservedKeys.includes(key.assetid)) continue;

        added_amount++
        offer.addMyItem(key);

        if (added_amount === amount) break;
    }

    if (added_amount < amount) {
        // should never happen, but just to be exact.
        payments.sendError(`Not enough keys reserved for offer ${offer.id} - ${amount} were requested, but only ${added_amount} were added.`);
        if(steamChat) client.chatMessage(steamID_64, `Not enough keys reserved for your trade offer - please contact us for assistance.`);
         if(callback) callback("Not enough keys reserved");
    if (responseWrapper && responseWrapper.isValid()) {
        responseWrapper.sendError("Not enough keys reserved");
    }
     return;
    }

    const balanceDifference = (-(Prices.buy * amount)) + (paid_via_crypto || 0);
    const updateResult = balanceDifference <= 0? await increaseBalanceOf(steamID_64, balanceDifference): null;

    if (updateResult === null) {
        payments.sendError(`Failed to update balance for ${steamID_64}`);
        if(steamChat) client.chatMessage(steamID_64, `Failed to update your balance - please contact us for assistance.`);
        if(callback) callback("Failed to update balance");
         if (responseWrapper && responseWrapper.isValid()) {
        responseWrapper.sendError("Failed to update balance");
    }
        return;
    }

    async function success() {
        const transactionId = await payments.createTransaction({ steamID_64, type: "buy", amount, offer_id: offer.id, paid_via_crypto: paid_via_crypto || false });

        transactions.set(offer.id, {
            type: "buy",
            steamID_64,
            offer,
            amount,
            paid_via_crypto,
            reservedKeys,
            transactionId,
            steamChat
        })

        userTransactionLock.set(steamID_64, transactionId)

        payments.sendNotification(`Offer #${offer.id} was sent sucessfully (${steamID_64} is buying ${amount} keys)`);
        if(steamChat) client.chatMessage(steamID_64, `Trade offer #${offer.id} was sent to you sucessfully!`);
        if(callback) callback(null, offer);
if (responseWrapper && responseWrapper.isValid()) {
    responseWrapper.sendJSON({ success: true, offer_id: offer.id });
}
    }

    function fail(err) {
        payments.sendError("Creating a buy offer failed, retrying in 3 seconds. ", err);

        if (retryCount >= (config.max_retry_attempts || 5)) {

            if(steamChat) client.chatMessage(steamID_64, `Failed to send trade offer on Steam after ${retryCount} attempts - please ${paid_via_crypto ? "contact us for assistance" : "try again later"}.`);
            releaseKeys(reservedKeys);

            increaseBalanceOf(steamID_64, -balanceDifference);

            if(callback) callback(err);
             if (responseWrapper && responseWrapper.isValid()) {
        responseWrapper.sendError("Failed to create offer after multiple attempts");
    }

        } else {
            setTimeout(() => {
                retry();
            }, 3000);
        }
    }

    let retryCount = 0;

    function retry() {
        retryCount++;

        try {
            offer.send(function (err, status) {
                if (err) {
                    fail(err);
                    return;
                }
        
                if (status == 'pending') {
                    console.log(`Offer #${offer.id} sent, but requires confirmation`);
        
                    community.acceptConfirmationForObject(config.account.identitySecret, offer.id, function (err) {
                        if (err) {
                            fail(err);
                        } else {
                            console.log("Offer confirmed");
                            success()
                        }
                    })
                } else success();
            });
        } catch (err) {
            fail(err);
        }
    }

    retry();
}


/**
 * Create a sell keys transaction
 */

async function createSellOffer({ callback = null, steamID_64, tradeLink, keys, amount, steamChat = true, responseWrapper = null }) {
    if(typeof steamID_64 === "object") {
        steamID_64 = steamID_64.getSteamID64();
    }

    let offer = manager.createOffer(tradeLink ? tradeLink: steamID_64);
    offer.setMessage("Sell Mann Co. Supply Crate Keys.");

    for (let i = 0; i < amount; i++) {
        offer.addTheirItem(keys[i]);
    }

    async function success() {
        const transactionId = await payments.createTransaction({ steamID_64, type: "sell", amount, offer_id: offer.id });

        transactions.set(offer.id, {
            type: "sell",
            steamID_64,
            offer,
            amount,
            transactionId,
            steamChat
        })

        userTransactionLock.set(steamID_64, transactionId)

        payments.sendNotification(`Offer #${offer.id} was sent sucessfully (${steamID_64} is selling ${amount} keys)`);
        if(steamChat) client.chatMessage(steamID_64, `Trade offer #${offer.id} was sent to you sucessfully!`);
        if(callback) callback(null, offer);
        if (responseWrapper && responseWrapper.isValid()) {
    responseWrapper.sendJSON({ success: true, offer_id: offer.id });
}
    }


    function fail(err) {
        payments.sendError("Creating a sell offer failed, retrying in 3 seconds. ", err);

        if (retryCount >= (config.max_retry_attempts || 5)) {

            if(steamChat) client.chatMessage(steamID_64, `Failed to send trade offer on Steam after ${retryCount} attempts - please try again later.`);
            if(callback) callback(err);
if (responseWrapper && responseWrapper.isValid()) {
        responseWrapper.sendError("Failed to create offer after multiple attempts");
    }

        } else {
            setTimeout(() => {
                retry();
            }, 3000);
        }
    }

    let retryCount = 0;

    function retry() {
        retryCount++;

        try {
            offer.send(function (err, status) {
                if (err) {
                    fail(err);
                    return;
                }

                if (status == 'pending') {
                    console.log(`Offer #${offer.id} sent, but requires confirmation`);

                    community.acceptConfirmationForObject(config.account.identitySecret, offer.id, function (err) {
                        if (err) {
                            fail(err);
                        } else {
                            console.log("Offer confirmed");
                            success()
                        }
                    })
                } else success();
            });
        } catch (err) {
            fail(err);
        }
    }

    retry();
}


/**
 * Validate a buy keys transaction
 * @returns {Promise<string|array>} - Returns a message if validation fails, or an array like [keys, cost, cantAfford] if successful
 */

async function ValidateBuyKeys({ amount, user, steamID_64, isAdmin = false }) {
    if (!isAdmin && userTransactionLock.has(steamID_64)) {
        return config.messages.pending;
    }

    const balance = (user && user.balance) || 0;

    if(isNaN(amount) || amount <= 0) {
        return 'Amount must be more than 0. Usage: !buy <amount>';
    }

    if(amount > Prices.max){
        return `Maximum amount of keys is ${Prices.max}`;
    }

    try {
        stockUpdated();
        const keys = await getKeysInStock();
    
        if (!Array.isArray(keys)) {
            payments.sendError(`Error fetching inventory:`, keys);
            return 'Error fetching keys in stock. Please try again later!';
        }
    
        if ((keys.length - reservedItems.size) < amount) {
            return `Not enough keys in stock (${Math.max(0, keys.length - reservedItems.size)} is available, ${reservedItems.size} is locked and may become available shortly - you can try again in a while)`;
        }
    
        const cost = amount * Prices.buy;

        return [ keys, cost, (!isAdmin && (isNaN(amount) || balance < cost)) || !user || !user.balance ];
    } catch (err) {
        payments.sendError(`Error processing buy offer on the website for ${steamID_64}:`, err);
        return 'An error occurred while validating your purchase. Please try again later.';
    }
}


/**
 * Validate withdrawal transaction
 * @returns {Promise<string|boolean>} - Returns a message if validation fails, or true if successful
 */

async function ValidateWithdrawal({ amount, address, currency_code, user, steamID_64, isAdmin = false }) {
    if (!isAdmin && userTransactionLock.has(steamID_64)) {
        return config.messages.pending;
    }

    // let provider = PAYMENT_PROCESSORS[(command[4] || "").toUpperCase()];

    // if(typeof provider !== "number") {
    //     // return config.messages.invalid_provider;
    //     provider = PAYMENT_PROCESSORS.NOWPAYMENTS;
    // }

    const balance = (user && user.balance) || 0;

    if (!address) {
        return `You have not provided an address for your payout (Usage is: !withdraw <address> <currency> <amount>).`;
    }

    // Calculate the minimum withdrawal amount, including the service fees
    const minimum = (Prices.fee / 100) + .8;
     const epsilon = 0.01;
    const isAmountWithinEpsilonOfBalance = Math.abs(balance - amount) < epsilon;
if (!isAdmin && (isNaN(amount) || (balance < amount && !isAmountWithinEpsilonOfBalance) || amount < minimum))
     {
        return `You do not have enough to withdraw $${amount.toFixed(2)}, or the amount is too small (< ${minimum.toFixed(2)}$): you have ${user.balance.toFixed(2)}$`;
    }
    if (isAmountWithinEpsilonOfBalance) {
        // Adjust amount to be exactly the balance
        amount = balance;
    }

    const currency = Currencies.find(c => c.code === currency_code);

    if (!currency) {
        return `Invalid currency provided - please use one of the following: ${Currencies.map(c => c.code).join(", ")}`;
    }

    if(currency.wallet_regex) {
        currency.regex ??= new RegExp(currency.wallet_regex);

        if(!currency.regex.test(address)) {
            return `Invalid address provided for ${currency.name} - please double-check it.`;
        }
    }

    // if(provider === PAYMENT_PROCESSORS.BINANCE) {
    //     if (currency_code !== "USDT") {
    //         return `Please only use USDT as the currency for now.`;
    //     }
    // }

    return true;
}


/**
 * Validate a sell keys transaction
 * @returns {Promise<string|array>} - Returns a message if validation fails, or an array of keys if successful
 */

async function ValidateSellKeys({ amount, user, steamID_64, isAdmin = false }) {
    if (!isAdmin && userTransactionLock.has(steamID_64)) {
        return config.messages.pending;
    }

    if(isNaN(amount) || amount <= 0) {
        return 'Amount must be more than 0. Usage: !sell <amount>';
    }


    // Update the stock count
    stockUpdated();
    await getKeysInStock();

    if((amount + cache.stockCount) > Prices.max){
        return `Sorry, your ourder exceeds the total limit of keys - please sell only up to ${cache.stockCount - Prices.max} keys.`;
    }

    try {
        return await new Promise(resolve => {
            manager.getUserInventoryContents(steamID_64, 440, 2, false, function (err, inventory, currency) {
                if (err) {
                    payments.sendError(`Error fetching inventory for ${steamID}:`, err);
                    client.chatMessage(steamID, 'Error fetching your inventory. Please try again later, and make sure your profile is not private.');
                    return resolve();
                }
    
                const keys = inventory && inventory.filter(item => item.classid === config.classid);
    
                if (!isAdmin && keys.length < amount) {
                    return resolve(`You don't have enough Mann Co. Supply Crate Keys - ${keys.length} keys were found.`);
                }
    
                resolve(keys);
            });
        });
    } catch (err) {
        payments.sendError(`Error validating sell keys:`, err);
        return 'An error occurred while validating your purchase. Please try again later.';
    }
}



/**
 * lastCheckedStock must be set to 0 after every trade
 */

let lastCheckedStock = 0;
function stockUpdated(){
    lastCheckedStock = 0;
}

function getKeysInStock() {
    if (cache.stockCount && (Date.now() - lastCheckedStock) < 300_000) {
        return cache.stock;
    }

    return new Promise((resolve, reject) => {
        manager.getInventoryContents(440, 2, false, function (err, inventory) {
            const keys = inventory && inventory.filter(item => item.classid === config.classid);

            if(!err) {
                cache.stock = keys;
                cache.stockCount = keys.length;
                lastCheckedStock = Date.now();

                ws_publish("global", {
                    type: "patch",
                    prices: { stock: cache.stockCount }
                })

                updatePersona();
            }

            resolve(err || keys);
        })
    })
}


function trim(string) {
    return string.split("\n").map(line => line.trim()).join("\n").trim();
}



/*
    Handle incomming commands
*/

const commands = new Map, command_names = new Set;

class Command {
    constructor(name, options = {}, callback = null) {
        this.name = (Array.isArray(name)? name[0]: name).toLowerCase();
        this.callback = callback;
        this.options = options;
        
        if(!this.options.arguments) this.options.arguments = [];

        command_names.add(this.name);

        if(Array.isArray(name)) {
            for(const alias of name) {
                commands.set(alias, this);
            }
        } else commands.set(this.name, this);
    }

    get usage() {
        let usage = `!${this.name}`;

        for(const arg of this.options.arguments) {
            if(!arg || typeof arg !== "object") continue;

            usage += ` <${(arg.required? "": "?") + arg.name}>`;
        }
        
        return usage;
    }
}


const sentWarnings = new Set();

client.on('friendMessage', async (steamID, message) => {
    const steamID_64 = steamID.getSteamID64();

    if (Banlist[steamID_64]) {
        payments.sendError(`Banned user ${steamID_64} tried to speak:`, message);

        if (!sentWarnings.has(steamID_64)) {
            client.chatMessage(steamID, `You have been blocked from using this bot. Contact us for further assistance.`);
            sentWarnings.add(steamID_64);
        }

        return;
    }

    if(message[0] !== "!") {
        payments.chatLog(steamID_64, message);
        return;
    }

    let user = await getUser(steamID);

    const isAdmin = config.admin.activated.has(steamID_64);
    const command = message.split(' ').filter(Boolean);

    let handler = command.shift().toLowerCase();
        handler = commands.get(handler.slice(1));

    payments.chatLog(steamID_64, message, handler);

    if (handler) {
        if (handler.options.admin && !isAdmin) return;
        if (handler.options.inactiveAdmin && !config.admin.profiles.includes(steamID_64)) return;

        for(let i = 0; i < handler.options.arguments.length; i++) {
            const arg = handler.options.arguments[i];
            const value = command[i];

            if(arg.required && !value) {
                return client.chatMessage(steamID, `Missing the required <${arg.name}>.\nUsage: ${handler.usage}${handler.options.example? `\n\nExamples:\n${Array.isArray(handler.options.example)? handler.options.example.join("\n"): handler.options.example}`: ""}`);
            }

            if(value && arg.type === "number" && value.toLowerCase() !== "all") {
                const amount = parseFloat(value);

                if(isNaN(amount)) {
                    return client.chatMessage(steamID, `Argument <${arg.name}> has to be a number.`);
                }
            }
        }

        try {
            handler.callback({ steamID, steamID_64, user, isAdmin, command, message });
        } catch (err) {
            payments.sendError(`Error executing command ${handler.name}:`, err);
            client.chatMessage(steamID, 'Sorry, there was an error while processing your command. Please try again later.');
        }

    } else {
        client.chatMessage(steamID, `I don't understand that command. Type !help for a list of commands.`);
    }
})


/*
    Define commands
*/

new Command("ping", { description: "Pong!", hidden: true }, ({ steamID }) => {
    client.chatMessage(steamID, 'Pong!');
});

new Command(["help", "?", "h"], { description: "Display a list of commands" }, ({ steamID }) => {
    let result = "Commands:\n"

    for(const command of command_names) {
        const handler = commands.get(command);

        const isAdmin = config.admin.profiles.includes(steamID.getSteamID64());

        if((isAdmin || !handler.options.hidden) && (isAdmin ? true : !handler.options.admin && !handler.options.inactiveAdmin)) {
            result += "\n" + handler.usage + (handler.options.description? " - " + handler.options.description: "") + (handler.options.admin? " (admin)": "");
        }
    }

    client.chatMessage(steamID, `${result}\n\n? = optional argument\n\nTry our website for a smoother trading experience: https://${config.http.domain}`);
});

new Command(["example", "ex"], { description: "Display example usage or instructions for a specific command", arguments: [{ name: "command", required: true }] }, ({ steamID, command }) => {
    const handler = commands.get(command[0]);

    if(!handler) {
        return client.chatMessage(steamID, `Command not found.`);
    }

    client.chatMessage(steamID, `Description: ${handler.options.description}\nBasic usage: ${handler.usage}` + (handler.options.example? "\n\nExamples:\n" + (Array.isArray(handler.options.example)? handler.options.example.join("\n"): handler.options.example): "\nThere is no example usage for this command.") + "\n\n? = optional argument");
});

new Command(["balance", "bal"], { description: "Display your balance" }, ({ steamID, user }) => {
    client.chatMessage(steamID, `Your balance is ${user.balance.toFixed(2)}$`);
});

new Command("currencies", { description: "Display available currencies" }, ({ steamID }) => {
    client.chatMessage(steamID, `Available currencies: ${Currencies.map(c => c.code).join(", ")}`);
});

new Command("networks", { description: "Display available networks for USDT" }, ({ steamID }) => {
    client.chatMessage(steamID, `Available USDT networks: ${[...new Set(Currencies.filter(c => c.code.startsWith("USDT")).map(c => c.network))].join(", ")}`);
});

new Command(["prices", "p", "price"], { description: "Display current prices" }, ({ steamID }) => {
    client.chatMessage(steamID, `Current prices:\n${Prices.buy}$ per key\n${Prices.sell}$ received for each sold key`);
});

new Command(["contact", "dc", "support", "discord"], { description: "Get links to our Discord server and website" }, ({ steamID }) => {
    client.chatMessage(steamID, trim(config.messages.contact) + `\n\nWebsite: https://${config.http.domain}`);
});

new Command(["cancel", "c"], { description: "Cancel your pending trade or transaction" }, async ({ steamID, steamID_64, message }) => {
    if (!userTransactionLock.has(steamID_64)) {
        return client.chatMessage(steamID, 'You don\'t have any pending trade offers.');
    }

    const transactionId = userTransactionLock.get(steamID_64);
    const transaction = await payments.getTransaction(transactionId);

    const offer = transactions.get(transaction.offer_id);
    if (offer && offer.reservedKeys) {
        releaseKeys(offer.reservedKeys)
    }

    // For key trade offers
    if (offer && offer.offer) {
        offer.offer.cancel(err => {
            if (err) {
                payments.sendError(err)
                return client.chatMessage(steamID, 'Failed canceling your trade offer.');
            }

            transactions.delete(transaction.offer_id)
            userTransactionLock.delete(steamID_64)
            client.chatMessage(steamID, 'Successfully canceled your trade offer.');
        })
    } else {
        if (offer.type === "withdrawal") {
            return client.chatMessage(steamID, config.messages.withdrawal_cancel);
        }

        if (offer.type === "buy_keys" && !message.includes("confirm")) {
            return client.chatMessage(steamID, config.messages.confirm_cancel_deposit);
        }

        client.chatMessage(steamID, 'Your transaction has been canceled, you can procceed now.');
        userTransactionLock.delete(steamID_64)
    }
});

new Command(["sell", "s"], { description: "Sell keys", example: "!sell 5", arguments: [{ name: "amount", type: "number", required: true }] }, async ({ steamID, steamID_64, user, isAdmin, command }) => {
    const amount = parseInt(command[0], 10);

    const keys = await ValidateSellKeys({ amount, user, steamID_64, isAdmin });
    if (!Array.isArray(keys)) {
        return client.chatMessage(steamID, keys);
    }

    createSellOffer({ steamID_64, keys, amount, steamChat: true });
});


new Command(["buy", "buytf", "b"], { description: "Buy keys", example: "!buy 5", arguments: [{ name: "amount", type: "number", required: true }] }, async ({ steamID, steamID_64, user, isAdmin, command }) => {
    const balance = (user && user.balance) || 0;
    const amount = parseInt(command[0], 10);
    
    const check = await ValidateBuyKeys({ amount, user, steamID_64, isAdmin });

    if (!Array.isArray(check)) {
        return client.chatMessage(steamID, check);
    }

    try {
        const [keys, cost, cantAfford] = check;

        if (cantAfford) {
            const paid_via_crypto = parseFloat((cost - balance).toFixed(2));
            const can_afford = Math.floor(balance / Prices.buy);

            if (balance < cost && paid_via_crypto < Prices.minimum_order) {
                return client.chatMessage(steamID, `Sorry, the minimum order is currently ${Prices.minimum_order}$, yours is the value of ${paid_via_crypto}$ - please buy at least ${Math.ceil(Prices.minimum_order / Prices.buy) - amount} additional keys${can_afford? " or only " + can_afford + " keys so they are purchased directly from your balance.": ""}.`);
            }

            const transactionId = await payments.createTransaction({ steamID, type: "purchase_deposit", amount });

            return payments.createInvoice(transactionId, paid_via_crypto, (error, response_data) => {
                if(error) {
                    return client.chatMessage(steamID, 'Failed to create invoice - please try again later.');
                }

                const invoice_id = String(response_data.id);

                payments.sendNotification("Created a purchase deposit with ID: #" + invoice_id + ", user " + steamID_64);

                userTransactionLock.set(steamID_64, transactionId);
                client.chatMessage(steamID, `You need an additional ${response_data.price_amount}$ to buy ${amount} ${amount > 1 ? "keys" : "key"} - please pay it here (do not forget to include any network fees in your payment): ${response_data.invoice_url} (invoice ID: #${invoice_id}).`);
            })

        } else createBuyOffer({ steamID_64, keys, amount, reservedKeys: reserveKeys(keys, amount), steamChat: true, paid_via_crypto: false });

    } catch (err) {
        payments.sendError(`Error processing !buy command for ${steamID}:`, err);
        client.chatMessage(steamID, 'An error occurred. Please try again later.');
    }
});

new Command(["withdraw", "w"], { description: "Withdraw your balance, in USD, to crypto", example: [/*"!withdraw 10 0x123456789 USDT BSC",*/ "!withdraw all ltc1... LTC", "!withdraw all ... USDT", /*`Available USDT networks: ${config.payments.networks.join(", ")}`*/], arguments: [{ name: "address", required: true }, { name: "currency", required: true }, { name: "amount" },/*{ name: "network", required: true }, { name: "provider" }*/] }, async ({ steamID, steamID_64, user, isAdmin, command }) => {
    const address = command[0];
    const currency_code = (command[1] || "USDT").toUpperCase();
    const amount = command[2] ? (command[2].toLowerCase() === "all" ? user.balance : parseFloat(command[2], 10)) : user.balance;

    const check = await ValidateWithdrawal({ amount, address, currency_code, user, steamID_64, isAdmin });
    if (check !== true) {
        return client.chatMessage(steamID, check);
    }

    payments.sendNotification("Withdrawal request from", steamID_64, "for the amount", amount, currency_code, "in currency:", currency, address);

    client.chatMessage(steamID, `Your withdrawal of ${amount}$ in ${currency_code} has started processing. You will soon receive an update.`);

    payments.createWithdrawal({
        steamID_64,
        amount,
        currency: currency_code,
        address,

        onFailed(error) {
            client.chatMessage(steamID, `Your withdraw of ${amount}$ to the address ${address} couldnt be created! Please double-check your information or try again later.`);
        },

        processing(id) {
            client.chatMessage(steamID, `Withdrawal with ID #${id} to ${address} with the amount of ${amount}$ has been started! Once completed, you will receive an update message.`);
        }
    });
});

new Command(["deposit", "dep", "d"], { description: "Deposit funds with crypto", example: ["!dep 10", /*"!dep binance", "\nDon't forget to specify the amount for NOWPayments deposits."*/], arguments: [{ name: "amount", type: "number" }, { name: "provider" }] }, async ({ steamID, steamID_64, user, isAdmin, command }) => {
    if (!isAdmin && userTransactionLock.has(steamID_64)) {
        return client.chatMessage(steamID, config.messages.pending);
    }

    let amount = parseFloat(command[0], 10);
    let provider = PAYMENT_PROCESSORS[(command[1] || "").toUpperCase()];

    if(typeof provider !== "number") {
        // return client.chatMessage(steamID, config.messages.invalid_provider);
        provider = PAYMENT_PROCESSORS.NOWPAYMENTS;
    }

    if(provider === PAYMENT_PROCESSORS.BINANCE) {
        client.chatMessage(steamID, `Please send ${amount || "an amount of your choice of"} *USDT* to this Binance account ID: ${config.payments.binance.account_id || config.payments.binance.address} and include this as the note: ${steamID_64}`);
        return;
    }

    if (!isAdmin && (isNaN(amount) || amount < .8)) {
        return client.chatMessage(steamID, `Invalid amount provided - minimum amount is 0.8$`);
    }

    const transactionId = await payments.createTransaction({ steamID, type: "deposit", amount });

    payments.createInvoice(transactionId, amount, (error, response_data) => {
        if(error) {
            return client.chatMessage(steamID, 'Failed to create invoice - please try again later.');
        }

        const invoice_id = String(response_data.id);

        payments.sendNotification("Created a deposit transaction with ID: #" + invoice_id + ", user " + steamID_64 + ", amount: " + amount + "$");

        userTransactionLock.set(steamID_64, transactionId);
        client.chatMessage(steamID, `Success! Invoice with ID #${invoice_id} has been generated. Do not forget to include the network fee in your payment! Please pay ${Math.round(response_data.price_amount)}$ here: ${response_data.invoice_url}\nYour payment will be processed within a few minutes after payment. You will get a message once it's completed.`);
    })
});

new Command("set_sell", { inactiveAdmin: true, description: "Set the buy price for keys", arguments: [{ name: "amount", type: "number" }] }, ({ steamID, command }) => {
    if(!command[0]) {
        return client.chatMessage(steamID, "Current price is " + Prices.buy + "$");
    }
    
    const amount = parseFloat(command[0], 10);
    Prices.buy = amount;

    fs.writeFileSync("./data/prices.json", JSON.stringify(Prices, null, 4));

    ws_publish("global", {
        type: "patch",
        prices: { buy: amount }
    })

    client.chatMessage(steamID, 'The user will now pay ' + amount + ' for every key');
    updatePersona();
});

new Command("set_buy", { inactiveAdmin: true, description: "Set the sell price for keys", arguments: [{ name: "amount", type: "number" }] }, ({ steamID, command }) => {
    if(!command[0]) {
        return client.chatMessage(steamID, "Current price is " + Prices.sell + "$");
    }
    
    const amount = parseFloat(command[0], 10);
    Prices.sell = amount;

    fs.writeFileSync("./data/prices.json", JSON.stringify(Prices, null, 4));

    ws_publish("global", {
        type: "patch",
        prices: { sell: amount }
    })

    client.chatMessage(steamID, 'The user will now receive ' + amount + ' for each key they sell');
    updatePersona();
});

new Command("fee", { inactiveAdmin: true, description: "Set the fixed deposit/withdrawal fee as percentage", arguments: [{ name: "value", type: "number" }] }, ({ steamID, command }) => {
    if(!command[0]) {
        return client.chatMessage(steamID, "Current fee is " + Prices.fee + "%");
    }
    
    const value = parseFloat(command[0], 10);
    Prices.fee = value;

    fs.writeFileSync("./data/prices.json", JSON.stringify(Prices, null, 4));

    ws_publish("global", {
        type: "patch",
        prices: { fee: value }
    })

    client.chatMessage(steamID, 'The fee is now ' + value + '%');
    updatePersona();
});

new Command("cap", { inactiveAdmin: true, description: "Set the max key stock", arguments: [{ name: "value", type: "number" }] }, ({ steamID, command }) => {
    if(!command[0]) {
        return client.chatMessage(steamID, "Current stock cap is " + Prices.max + " keys");
    }
    
    const value = parseFloat(command[0], 10);
    Prices.max = value;

    fs.writeFileSync("./data/prices.json", JSON.stringify(Prices, null, 4));

    ws_publish("global", {
        type: "patch",
        prices: { max: value }
    })

    client.chatMessage(steamID, 'The stock cap has been set to ' + value + ' keys');
    updatePersona();
});

new Command("set_transaction_status", { inactiveAdmin: true, description: "Change the transaction status", arguments: [{ name: "id" }] }, ({ steamID, command }) => {
    if(!command[0]) {
        return client.chatMessage(steamID, "Current stock cap is " + Prices.max + " keys");
    }
    
    const transactionId = command[0];
    const transaction = transactions.get(transactionId);
    if(!transaction) {
        return client.chatMessage(steamID, "Transaction not found");
    }

    const status = command[1] || "finished";
    payments.updateTransaction(transactionId, { status });

    client.chatMessage(steamID, transactionId + ' has been set to ' + status);
});

new Command("min", { inactiveAdmin: true, description: "Set the minimum order value in USD", arguments: [{ name: "value", type: "number" }] }, ({ steamID, command }) => {
    if(!command[0]) {
        return client.chatMessage(steamID, "Current minimum order value is " + Prices.minimum_order + "$");
    }
    
    const value = parseFloat(command[0], 10);
    Prices.minimum_order = value;

    fs.writeFileSync("./data/prices.json", JSON.stringify(Prices, null, 4));

    ws_publish("global", {
        type: "patch",
        prices: { minimum_order: value }
    })

    client.chatMessage(steamID, 'The minimum order value is now ' + value + '$');
    updatePersona();
});

new Command("set_balance", { inactiveAdmin: true, description: "Set the balance of an user", arguments: [{ name: "user_id", required: true }, { name: "value", type: "number", required: true }] }, async ({ steamID, steamID_64, command }) => {
    const targetSteamID = command[0] === "me" ? steamID_64 : command[0];
    const newBalance = parseFloat(command[1], 10);

    const result = await usersCollection.updateOne(
        { steamID: targetSteamID },
        { $set: { balance: newBalance } }
    );

    ws_publish(steamID_64, {
        type: "patch",
        user: { balance: newBalance }
    })

    client.chatMessage(steamID, result.matchedCount === 0 ? "Failed to update balance (user not found)" : 'Done');
});

new Command("add_balance", { inactiveAdmin: true, description: "Increase/Decrease the balance of an user", arguments: [{ name: "user_id", required: true }, { name: "value", type: "number", required: true }] }, async ({ steamID, steamID_64, command }) => {
    const targetSteamID = command[0] === "me" ? steamID_64 : command[0];

    const newBalance = await increaseBalanceOf(targetSteamID, parseFloat(command[1], 10));

    client.chatMessage(steamID, 'Done, new balance is ' + newBalance + '$');
});

new Command("admin", { inactiveAdmin: true, description: "Toggle admin mode", hidden: true }, ({ steamID, steamID_64 }) => {
    console.log(config.admin.profiles);
    
    if (!config.admin.profiles.includes(steamID_64)) return;

    if (config.admin.activated.has(steamID_64)) {
        config.admin.activated.delete(steamID_64);
        return client.chatMessage(steamID, "Admin off");
    }

    config.admin.activated.add(steamID_64);
    return client.chatMessage(steamID, "Admin on");
});

new Command("a_get_data", { inactiveAdmin: true, description: "Get user data", arguments: [{ name: "user_id", required: true }] }, async ({ steamID, command }) => {
    const targetSteamID = command[0];
    const result = await getUser(targetSteamID);

    client.chatMessage(steamID, JSON.stringify(result, null, 4));
});

new Command("ban", { inactiveAdmin: true, description: "Ban a user from steam chat", arguments: [{ name: "user_id", required: true }] }, async ({ steamID, command }) => {
    const targetSteamID = command[0];
    
    if (!targetSteamID) {
        return client.chatMessage(steamID, "Please provide a valid SteamID to ban.");
    }

    if (Banlist[targetSteamID]) {
        return client.chatMessage(steamID, `${targetSteamID} is already banned.`);
    }

    Banlist[targetSteamID] = true;

    fs.writeFileSync("./data/banlist.json", JSON.stringify(Banlist, null, 4));

    ws_publish(targetSteamID, {
        type: "patch",
        user: { ban_status: Banlist[targetSteamID] }
    })

    client.chatMessage(steamID, `${targetSteamID} has been banned.`);
});

new Command("unban", { inactiveAdmin: true, description: "Unban a user from steam chat", arguments: [{ name: "user_id", required: true }] }, async ({ steamID, command }) => {
    const targetSteamID = command[0];
    
    if (!targetSteamID) {
        return client.chatMessage(steamID, "Please provide a valid SteamID to unban.");
    }

    if (!Banlist[targetSteamID]) {
        return client.chatMessage(steamID, `${targetSteamID} is not banned.`);
    }

    delete Banlist[targetSteamID];

    fs.writeFileSync("./data/banlist.json", JSON.stringify(Banlist, null, 4));

    ws_publish(targetSteamID, {
        type: "patch",
        user: { ban_status: Banlist[targetSteamID] }
    })

    client.chatMessage(steamID, `${targetSteamID} has been unbanned.`);
});

new Command("restart", { inactiveAdmin: true, description: "Restart the bot" }, async ({ steamID, command }) => {
    if (!config.admin.profiles.includes(steamID.getSteamID64())) return;

    if(transactions.size > 0 && !command.includes("force")) {
        return client.chatMessage(steamID, "It seems like there are some pending key transactions - it is recommended that you wait for them to complete. Use \"!restart force\" to force a restart.");
    }
    
    client.chatMessage(steamID, "Restarting bot...");
    await new Promise(resolve => setTimeout(resolve, 500));
    process.exit(0);
});



/*
    Handle trade updates
*/

manager.on('sentOfferChanged', async function (offer, oldState) {
    console.log(`Sent offer #${offer.id} has changed: ${TradeOfferManager.ETradeOfferState[oldState]} -> ${TradeOfferManager.ETradeOfferState[offer.state]}`);

    if (offer.state == TradeOfferManager.ETradeOfferState.Accepted) {
        const offer_details = transactions.get(offer.id);

        // Invalid trade, this shouldnt ever happen (but just in case...)
        if (!offer_details) {
            payments.sendError(`### Offer #${offer.id} was not found in transactions, most likely it was accepted while the bot was restarting or offline.`, { offer });
            return;
        }

        const steamChat = offer_details.steamChat;
        const steamID_64 = offer_details.steamID_64;
        const isAdmin = config.admin.activated.has(steamID_64);
        const transaction = await payments.getTransaction(offer_details.transactionId);

        offer.getExchangeDetails(async (err, status, tradeInitTime, receivedItems, sentItems) => {
            if (err) {
                payments.sendError(`Error in offer #${offer.id}:`, err);
                if(steamChat) client.chatMessage(steamID_64, "Sorry, couldn't process your trade offer." + (transaction.paid_via_crypto ? "\nPlease contact us for assistance!" : ""));

                await payments.updateTransaction(offer_details.transactionId, { status: "failed", error: err.message });
                return;
            }

            let message = "";

            // Finalize changes done in the trade
            const
                receivedKeys = receivedItems.map(item => item.classid).filter(item => item === config.classid).length,
                sentKeys = sentItems.map(item => item.classid).filter(item => item === config.classid).length,

                // Changed to just keys
                soldPrice = ((receivedKeys * Prices.sell) || 0).toFixed(2),
                boughtPrice = ((sentKeys * Prices.buy) || 0).toFixed(2)
            ;


            if (receivedKeys) {
                message += ` sold ${receivedKeys} ${receivedKeys > 1 ? "keys" : "key"} for ${soldPrice}$`

                await increaseBalanceOf(steamID_64, +soldPrice);

                if (sentKeys) message += ", and ";
            }

            if (sentKeys) {
                message += ` bought ${sentKeys} ${receivedKeys > 1 ? "keys" : "key"} for ${boughtPrice}$`;
            }

            const balanceDifference = soldPrice - boughtPrice + (transaction.paid_via_crypto || 0);

            // Release keys that have been reserved for the trade
            if (offer_details.reservedKeys) {
                releaseKeys(offer_details.reservedKeys);
            }

            // Log that the transaction has been done
            await payments.updateTransaction(offer_details.transactionId, { status: "finished", difference: balanceDifference });

            if(steamChat) client.chatMessage(steamID_64, `You have sucessfully ${message || "done nothing.. somehow"}!${isAdmin ? " (No difference was made on your account since you are an admin.)" : ""}`);
            console.log(`Offer #${offer.id} (by ${steamID_64}) finished - received keys ${receivedKeys}, sent keys ${sentKeys} - status ${TradeOfferManager.ETradeStatus[status]}`)

            stockUpdated();

            // Delete and release the offer once transaction complete
            transactions.delete(offer.id)
            userTransactionLock.delete(steamID_64)
        })

    } else if (offer.state == TradeOfferManager.ETradeOfferState.Declined || offer.state == TradeOfferManager.ETradeOfferState.Canceled || offer.state == TradeOfferManager.ETradeOfferState.Invalid || offer.state == TradeOfferManager.ETradeOfferState.Expired) {
        const offer_details = transactions.get(offer.id);

        // Invalid trade, this shouldnt ever happen (but just in case...)
        if (!offer_details) return;

        const steamID_64 = offer_details.steamID_64;

        if(offer_details.type === "buy") {
            const balanceDifference = -(offer_details.amount * Prices.buy) + (offer_details.paid_via_crypto || 0);
            await payments.updateTransaction(offer_details.transactionId, { status: "finished", difference: balanceDifference });
            await payments.refund_withdrawal(offer_details.transactionId);
        }

        if(offer_details.steamChat) client.chatMessage(steamID_64, "Trade offer #" + offer.id + " declined.");

        // Delete and release the offer once transaction complete
        transactions.delete(offer.id)
        userTransactionLock.delete(steamID_64)
    }
});




/*
    Handle trade updates
*/

manager.on('newOffer', function (offer) {
    console.log("New offer #" + offer.id + " from " + offer.partner.getSteam3RenderedID());
    offer.accept(function (err, status) {
        if (err) {
            console.log("Unable to accept offer: " + err.message);
        } else {
            console.log("Offer accepted: " + status);
            if (status == "pending") {
                community.acceptConfirmationForObject(config.account.identitySecret, offer.id, function (err) {
                    if (err) {
                        console.log("Can't confirm trade offer: " + err.message);
                    } else {
                        console.log("Trade offer " + offer.id + " confirmed");
                    }
                });
            }
        }
    });
});

manager.on('receivedOfferChanged', function (offer, oldState) {
    console.log(`Offer #${offer.id} changed: ${TradeOfferManager.ETradeOfferState[oldState]} -> ${TradeOfferManager.ETradeOfferState[offer.state]}`);

    if (offer.state == TradeOfferManager.ETradeOfferState.Accepted) {
        offer.getExchangeDetails((err, status, tradeInitTime, receivedItems, sentItems) => {
            if (err) {
                console.log(`Error ${err}`);
                return;
            }

            // Create arrays of just the new assetids using Array.prototype.map and arrow functions
            let newReceivedItems = receivedItems.map(item => item.new_assetid);
            let newSentItems = sentItems.map(item => item.new_assetid);

            console.log(`Received items ${newReceivedItems.join(',')} Sent Items ${newSentItems.join(',')} - status ${TradeOfferManager.ETradeStatus[status]}`)
        })
    }
});




/*
    Handle API and notifications from NOWPayments
*/


function cors(res) {
    // Check if response is still accessible
    try {
        res.writeHeader("Access-Control-Allow-Origin", "http" + (config.http.ssl ? "s" : "") + "://" + config.http.domain);
        res.writeHeader("Access-Control-Allow-Credentials", "true");
        res.writeHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        res.writeHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Credentials");
        res.writeHeader("Access-Control-Max-Age", "86400");
        return res;
    } catch (error) {
        // Response has been aborted or already sent
        console.log("Attempted to access aborted response:", error.message);
        return null;
    }
}
function createResponseWrapper(res) {
    let isAborted = false;
    let isCompleted = false;
    
    res.onAborted(() => {
        isAborted = true;
    });
    
    return {
        isValid: () => !isAborted && !isCompleted,
        sendJSON: (data, status = "200 OK") => {
            if (isAborted || isCompleted) return false;
            try {
                const corsRes = cors(res);
                if (!corsRes) return false;
                
                corsRes.writeStatus(status);
                corsRes.writeHeader("Content-Type", "application/json");
                corsRes.end(JSON.stringify(data));
                isCompleted = true;
                return true;
            } catch (error) {
                console.log("Error sending response:", error.message);
                return false;
            }
        },
        sendError: function(message, status = "500 Internal Server Error") {
            return this.sendJSON({ error: message }, status);
        }
    };
}
/**
 * Realtime WebSocket handler
 */

app.ws("/", {
    // idleTimeout: 32,
    // maxBackpressure: 1024,
    maxPayloadLength: 32 * 1024,
    compression: uws.DEDICATED_COMPRESSOR_32KB,

    sendPingsAutomatically: true,

    upgrade(res, req, context) {
        // Upgrading a HTTP connection to a WebSocket
        const steamID_64 = website.getAuth(req, res, jwtSecret);

        if(steamID_64) {
            res.upgrade({
                url: req.getUrl(),
                steamID_64,
                ip: res.getRemoteAddress(),
                ipAsText: res.getRemoteAddressAsText()
            }, req.getHeader('sec-websocket-key'), req.getHeader('sec-websocket-protocol'), req.getHeader('sec-websocket-extensions'), context);
        }
    },

    open(ws) {
        ws.subscribe("global");
        ws.subscribe(ws.steamID_64);
    },
    
    // message(ws, message, isBinary) {
    // },
    
    // close(ws, code, message) {
    // }
})


function sortObject(obj) {
    return Object.keys(obj).sort().reduce(
        (result, key) => {
            result[key] = (obj[key] && typeof obj[key] === 'object') ? sortObject(obj[key]) : obj[key]
            return result
        },
        {}
    )
}


/**
 * HTTP API handler
 */

app.any("/*", async (res, req) => {
    const url = req.getUrl().replaceAll("%20", " ").replaceAll("//", "/");
    const method = req.getMethod();

    res.onAborted(() => {
        // Request aborted
    })

    if(method === "options") {
        cors(res).writeStatus("200 OK").end();
        return;
    }

    const index = url.indexOf("/", 1);

    switch(url.slice(1, index === -1? undefined: index + 1)) {
        case config.payments.nowPayments.ipn_callback: {
    if(method !== "post") return res.writeStatus("405 Method Not Allowed").end();

    req.body = Buffer.from('');
    req.contentType = req.getHeader('content-type');

    const signature = req.getHeader('x-nowpayments-sig');

    if(!signature) {
        payments.sendError("## Received an IPN callback without a signature\n(They were likely trying to exploit the system)\n", signature);
        return res.writeStatus("200 OK").end(); // Return 200 OK to prevent retries
    }

    res.onData((chunk, isLast) => {
        req.body = Buffer.concat([req.body, Buffer.from(chunk)]);

        let data;

        if (isLast) {
            try {
                data = JSON.parse(req.body.toString());
            } catch (error) { 
                payments.sendError("## Error parsing IPN JSON data:", error);
                return res.writeStatus("200 OK").end(); // Return 200 OK to prevent retries
            }

            // Always return 200 OK to prevent NowPayments from retrying
            res.writeStatus("200 OK").end();

            if(!data) {
                payments.sendError("## Empty data in IPN callback");
                return;
            }

            console.log("IPN data received:", JSON.stringify(data, null, 2));

            const hmac = crypto.createHmac('sha512', config.payments.nowPayments.ipn);
            hmac.update(JSON.stringify(sortObject(data)));
            const digest = hmac.digest('hex');

            if (signature !== digest) {
                payments.sendError("## Received an IPN callback with an invalid signature\n(They were likely trying to exploit the system)\n", signature, digest);
                return;
            }

            if(typeof data !== "object") {
                payments.sendError("## Invalid data type in IPN callback:", typeof data);
                return;
            }
            console.log("Raw IPN data received:", JSON.stringify(data, null, 2));


            data.status = data.payment_status || data.status;
data.id = String(data.batch_withdrawal_id || data.withdrawal_id || data.invoice_id);

const isDeposit = !!data.invoice_id;
let transactionId = isDeposit ? data.order_id : data.unique_external_id;

// For withdrawals, we need additional lookup methods if unique_external_id is missing
if (!isDeposit && (!transactionId || transactionId === 'undefined')) {
    console.log(`Withdrawal IPN missing unique_external_id, trying to find by batch_withdrawal_id: ${data.batch_withdrawal_id}`);
    
    // We need to wrap this in an async IIFE since we're in a promise chain
    (async () => {
        try {
            // Try to find the transaction by batch_withdrawal_id
            if (data.batch_withdrawal_id) {
                const transaction = await findTransactionByBatchWithdrawalId(data.batch_withdrawal_id);
                
                if (transaction) {
                    transactionId = transaction._id.toString();
                    console.log(`Found transaction ${transactionId} by batch_withdrawal_id ${data.batch_withdrawal_id}`);
                    
                    // Process the withdrawal with the found transaction
                    handleWithdrawalUpdate(transactionId, transaction, data);
                    return;
                } else {
                    payments.sendError(`Could not find transaction for batch_withdrawal_id ${data.batch_withdrawal_id}`, data);
                    return;
                }
            }
        } catch (error) {
            payments.sendError(`Error finding transaction by batch_withdrawal_id: ${error}`, data);
            return;
        }
    })();
    
    // Return early since we're handling it in the IIFE
    return;
}

console.log(`IPN type: ${isDeposit ? 'Deposit' : 'Withdrawal'}, using ID: ${transactionId}, status: ${data.status}`);

// Only proceed to the normal flow if we have a transaction ID
if (!transactionId || transactionId === 'undefined') {
    payments.sendError("## Missing transaction ID in IPN callback:", data);
    return;
}

payments.getTransaction(transactionId).then(transaction => {
    if(!transaction) {
        payments.sendError("## Transaction not found: ", transactionId);
        return;
    }

    console.log(`Processing ${isDeposit ? 'deposit' : 'withdrawal'} IPN for transaction ${transactionId} with status ${data.status}`);

    if(isDeposit) handleDepositUpdate(transactionId, transaction, data); 
    else handleWithdrawalUpdate(transactionId, transaction, data);
}).catch(error => {
    payments.sendError(`## Error getting transaction ${transactionId}:`, error);
});
        }
    });
    break;
}
        
        case "steam_login":
            const query = req.getQuery();
            const claimed_id = req.getQuery("openid.claimed_id");

            const check = await fetch("https://steamcommunity.com/openid/login", {
                method: "POST",
                body: query + "&openid.mode=check_authentication",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
            });
        
            const text = await check.text();
            const valid =  text.includes("is_valid:true");

            if (valid) {
                const steamID_64 = claimed_id.split("/").pop();

                // Add the user to the database if they don't exist
                await getUser(steamID_64);

                const token = jwt.sign({ id: steamID_64 }, jwtSecret, { expiresIn: '24h' });

                res.cork(() => {
                    res.writeStatus("302 Found")
                    res.writeHeader("Set-Cookie", `auth=${token}; HttpOnly; Path=/; ${(config.http.ssl? "Secure; ": "")}Max-Age=86400; Port=${config.http.port}`);
                    res.writeHeader("Location", `http${(config.http.ssl? "s": "")}://${config.http.domain}/`).end();
                });
            } else {
                res.cork(() => {
                    res.writeHeader("Content-Type", "application/json");
                    res.end(JSON.stringify({ success: false, message: "Invalid login" }));
                });
            }
            break;

        case "profile": {
            const steamID_64 = website.getAuth(req, res, jwtSecret);

            if(steamID_64){
                const user = await getUser(steamID_64);

                profileExtractor(steamID_64).then((extract) => {
                    res.cork(() => {
                        res.writeHeader("Content-Type", "application/json");
                        const result = { steamID_64, balance: Number(user.balance.toFixed(2)), tradelink: user.tradelink };
    
                        if (extract) {
                            result.username = extract("steamID");
                            result.avatar = extract("avatarMedium");
                        }
    
                        cors(res).end(JSON.stringify(result));
                    });
                });
            }
            break;
        }

        case "history": {
            const steamID_64 = website.getAuth(req, res, jwtSecret);

            if(steamID_64){
                const transactions = await (await db.collection('transactions').find({ steamID: steamID_64 }).sort({ date: 1 }).toArray()).reverse();

                res.cork(() => {
                    res.writeHeader("Content-Type", "application/json");
                    cors(res).end(JSON.stringify({
                        transactions
                    }));
                });
            }
            break;
        }

        case "set_tradelink": {
            const steamID_64 = website.getAuth(req, res, jwtSecret);

            if(steamID_64){
                const tradelink = req.getQuery("tradelink");

                if(!tradelink) return cors(res).writeStatus("400 Bad Request").end();

                await usersCollection.updateOne({ steamID: steamID_64 }, { $set: { tradelink } });

                cors(res).writeHeader("Content-Type", "application/json").end(JSON.stringify({ success: true }));
            }
            break;
        }

        case "buy": {
            const steamID_64 = website.getAuth(req, res, jwtSecret);

            if(steamID_64){
                const responseWrapper = createResponseWrapper(res);
                const amount = parseInt(req.getQuery("amount"), 10);
                const user = await getUser(steamID_64);

                if(!user.tradelink) {
                   responseWrapper.sendError("You need to set your tradelink first!");
                    
                    return;
                }

                const isAdmin = config.admin.activated.has(steamID_64);

                const check = await ValidateBuyKeys({ amount, user, steamID_64, isAdmin });
            
                if (!Array.isArray(check)) {
                     responseWrapper.sendError(check);
                    return;
                }
                
                try {
                    const [keys, cost, cantAfford] = check;
                    
                    if (!cantAfford) {
    createBuyOffer({ 
        tradeLink: user.tradelink, 
        steamID_64, 
        steamChat: false, 
        keys, 
        amount, 
        reservedKeys: reserveKeys(keys, amount),
        responseWrapper
    });
} else {
    responseWrapper.sendJSON({ error: `You cannot afford ${amount} keys, your balance is ${(user && user.balance) || 0}, you need ${cost}.` });
}
                } catch (err) {
                    payments.sendError(`Error processing buy offer on the website for ${steamID_64}:`, err);
                    if (responseWrapper.isValid()) {
        responseWrapper.sendJSON({ error: 'An error occurred. Please try again later.' });
    }
                }
            }
            break;
        }

        case "sell": {
            const steamID_64 = website.getAuth(req, res, jwtSecret);

            if(steamID_64){
                const responseWrapper = createResponseWrapper(res);
                const amount = parseInt(req.getQuery("amount"), 10);
                const user = await getUser(steamID_64);

                if(!user.tradelink) {
                    responseWrapper.sendJSON({ error: "You need to set your tradelink first!" });
                    return;
                }

                const isAdmin = config.admin.activated.has(steamID_64);

                const keys = await ValidateSellKeys({ amount, user, steamID_64, isAdmin });
                if (!Array.isArray(keys)) {
                    responseWrapper.sendJSON({ error: keys });
                    
                    return;
                }
               try {
    createSellOffer({ 
        tradeLink: user.tradelink, 
        steamID_64, 
        steamChat: false, 
        keys, 
        amount,
        responseWrapper
    });
} catch (err) {
    payments.sendError(`Error processing sell offer on the website for ${steamID_64}:`, err);
    if (responseWrapper.isValid()) {
        responseWrapper.sendJSON({ error: 'An error occurred. Please try again later.' });
    }
}
                
            }
            break;
        }

        case "deposit": {
            const steamID_64 = website.getAuth(req, res, jwtSecret);

            if(steamID_64){
                const amount = parseFloat(req.getQuery("amount"), 10);

                const transactionId = await payments.createTransaction({ steamID_64, type: "deposit", amount });

                payments.createInvoice(transactionId, amount, (error, response_data) => {
                    if(error) {
                        return cors(res).writeStatus("500 Internal Server Error").end();
                    }

                    const invoice_id = String(response_data.id);

                    payments.sendNotification("Created a deposit transaction with ID: #" + invoice_id + ", user " + steamID_64 + ", amount: " + amount + "$, using the website");

                    res.cork(() => {
                        res.writeHeader("Content-Type", "application/json");
                        cors(res).end(JSON.stringify({
                            url: response_data.invoice_url
                        }));
                    });
                })
            }
            break;
        }

        case "withdraw": {
            const steamID_64 = website.getAuth(req, res, jwtSecret);
            const address = req.getQuery("address");
            const currency_code = (req.getQuery("currency") || "USDT").toUpperCase();
            const amount = parseFloat(req.getQuery("amount"), 10);

            if(steamID_64) {
                const user = await getUser(steamID_64);
                const isAdmin = config.admin.activated.has(steamID_64);
                const check = await ValidateWithdrawal({ amount, address, currency_code, user, steamID_64, isAdmin });

                if (check !== true) {
                    res.cork(() => {
                        cors(res).writeHeader("Content-Type", "application/json").end(JSON.stringify({ error: check }));
                    });
                    return;
                }

                payments.sendNotification("Withdrawal request from", steamID_64, "for the amount", amount, currency_code, "in currency:", currency_code, address);

                payments.createWithdrawal({
                    steamID_64,
                    amount,
                    currency: currency_code,
                    address,
 
                    onFailed(error) {
                        res.cork(() => {
                            cors(res).writeHeader("Content-Type", "application/json").end(JSON.stringify({ error: `Your withdraw of ${amount}$ to the address ${address} couldnt be created! Please double-check your information or try again later.` }));
                        });
                    },
    
                    processing(id) {
                        res.cork(() => {
                            cors(res).writeHeader("Content-Type", "application/json").end(JSON.stringify({ id }));
                        });
                    }
                });
            }
            break;
        }

        case "logout":
            res.cork(() => {
                res.writeStatus("302 Found").writeHeader("Location", "http" + (config.http.ssl? "s": "") + "://" + config.http.domain);
                res.writeHeader("Set-Cookie", `auth=; HttpOnly; Path=/; ${(config.http.ssl? "Secure; ": "")}Max-Age=0; Port=${config.http.port}`);
                res.end();
            })
            break;

        case "prices":
            if (method !== "get") return res.writeStatus("405 Method Not Allowed").end();

            await getKeysInStock();

            res.cork(() => {
                res.writeHeader("Content-Type", "application/json");
                cors(res).end(JSON.stringify({
                    buy: Prices.buy,
                    sell: Prices.sell,
                    fee: Prices.fee,
                    min: Prices.minimum_order,
                    minimum_order: Prices.minimum_order,
                    max: Prices.max,
                    stock: cache.stockCount
                }));
            })
            break;
    

        case "estimator":
            if (method !== "get") return res.writeStatus("405 Method Not Allowed").end();

            const currency = req.getQuery("currency");

            if (!currency) return res.writeStatus("400 Bad Request").end();

            payments.getEstimate(1, currency, "usd", (err, value) => {
                if (err) {
                    payments.sendError("Error getting estimate:", err);
                    return res.writeStatus("500 Internal Server Error").end();
                }

                res.cork(() => {
                    res.writeHeader("Content-Type", "application/json");
                    cors(res).end(value);
                });
            })
            break;

        default:
            res.writeStatus("404 Not Found").end();
    }
})




        async function handleDepositUpdate(transactionId, transaction, data){
    const steamID_64 = transaction.steamID;

    if (data.status === 'finished' || data.status === 'partially_paid') {
        if(transaction.status === "finished") {
            payments.sendNotification("Deposit already completed:", data);
            return;
        }

        if(data.status === 'partially_paid') {
            if(data.price_amount - data.outcome_amount > 0.15) {
                payments.sendNotification("Invoice partially paid, and the amount was too low:", data);
            }
        }

        const feePercent = Prices.fee / 100;
        const amount = Number(data.outcome_amount);
        const fee = Math.round((amount * feePercent) * 100) / 100;
        const flatfee = 0.02;
        const totalfee = fee + flatfee;
        const outcome_amount = Math.round((amount - totalfee) * 100) / 100;
        await payments.updateTransaction(transactionId, { status: "finished", difference: outcome_amount });

        if (transaction.type === "purchase_deposit") {
            const keys = await getKeysInStock();

            createBuyOffer({
                steamID_64,
                steamChat: true,
                paid_via_crypto: outcome_amount,
                reservedKeys: reserveKeys(keys, transaction.amount),
                keys,
                amount: transaction.amount
            });
        } else {
            increaseBalanceOf(steamID_64, outcome_amount);
            client.chatMessage(steamID_64, `Your deposit of ${outcome_amount.toFixed(2)}$ has been successfully completed and added to your balance!`);
        }

        userTransactionLock.delete(steamID_64);
    }
    else if (data.status === "failed" || data.status === "rejected") {
        userTransactionLock.delete(steamID_64);

        payments.sendError('! Failed to complete deposit:', data);
        payments.updateTransaction(transactionId, { status: "failed" });
    }
}
   

async function handleWithdrawalUpdate(transactionId, transaction, data) {
    const steamID_64 = transaction.steamID;
    const withdraw_id = String(data.id || data.batch_withdrawal_id || data.withdrawal_id);
if (data.batch_withdrawal_id && !transaction.batch_withdrawal_id) {
        await payments.updateTransaction(transactionId, { 
            batch_withdrawal_id: data.batch_withdrawal_id
        });
    }
    // Log the withdrawal status change
    payments.sendNotification(`Withdrawal ${transactionId} status update: ${data.status}`);

    // Update transaction status immediately
    await payments.updateTransaction(transactionId, { 
        status: data.status,
        updated_at: new Date(),
        ipn_data: data // Store the IPN data for troubleshooting
    });

    if(data.status === 'CONFIRMED' || data.status === 'completed') {
        userTransactionLock.delete(steamID_64);

        payments.sendNotification("Withdraw success: ", data);

        client.chatMessage(steamID_64, `Your withdrawal of ${data.amount || transaction.amount}$ to the address ${data.address || transaction.address} for invoice ID ${withdraw_id} has been successfully completed! It should appear in your wallet shortly.`);
        
        // Final status update with complete details
        await payments.updateTransaction(transactionId, { 
            status: "finished",
            completed_at: new Date(),
            payout_hash: data.payout_hash || data.hash || null,
            payout_id: withdraw_id
        });
        ws_publish(steamID_64, {
            type: "update_transaction",
            id: transactionId,
            transaction: await payments.getTransaction(transactionId)
        });
    }
    else if(data.status === 'AWAITING_CONFIRMATION') {
        // Attempt to verify the withdrawal
        const verificationResult = await payments.verify_withdrawal(withdraw_id);
        
        if (!verificationResult.success) {
            payments.sendError(`Failed to auto-verify withdrawal ${withdraw_id} during IPN processing`, verificationResult.error);
            // Send notification to user that manual action might be needed
            client.chatMessage(steamID_64, `Your withdrawal is being processed. If it doesn't complete within an hour, please contact support.`);
        } else {
            client.chatMessage(steamID_64, `Your withdrawal is being processed and has been verified. You'll receive a confirmation when it's complete.`);
        }
    }
    else if(data.status === 'IN_PROGRESS' || data.status === 'processing' || data.status === 'confirming') {
        // Update the user about intermediate statuses
        client.chatMessage(steamID_64, `Your withdrawal is in progress (status: ${data.status}). You'll receive a confirmation when it's complete.`);
    }
    else if(data.status === 'FAILED' || data.status === 'rejected') {
        userTransactionLock.delete(steamID_64);
        payments.refund_withdrawal(transactionId);

        payments.sendError('! Failed to complete withdrawal:', data);

        client.chatMessage(steamID_64, `Your withdrawal of ${data.amount || transaction.amount}$ to the address ${data.address || transaction.address} for invoice ID ${withdraw_id} has failed!\nReason: ${data.error || "not provided."}\n\nYour funds have been returned to your balance.`);
    ws_publish(steamID_64, {
            type: "update_transaction",
            id: transactionId,
            transaction: await payments.getTransaction(transactionId)
        });
    }
}


/*
    Handle friend requests
*/

client.on('friendRelationship', (steamID, relationship) => {
    if (relationship === SteamUser.EFriendRelationship.RequestRecipient) {
        console.log(`Received a friend request from ${steamID.getSteamID64()}. Accepting...`);

        client.addFriend(steamID, async (err) => {
            const steamID_64 = steamID.getSteamID64();

            if (err) {
                return payments.sendError(`Failed to accept friend request from ${steamID_64}:`, err);
            }

            console.log(`Friend request from ${steamID_64} accepted!`);

            await getUser(steamID);

            client.chatMessage(steamID, 'Thank you for adding me!\n\nTo get started, type !help for a list of commands.');
            // client.chatMessage(steamID, 'Thank you for adding me!\n\nTo get started, chose how you want to interact with me:\nType "1" to use steps, good if you are a newbie\nType "2" to use regular commands, if you are already an experienced user\n\nType !help for more information.');
        });
    }
})




/*
    Initialization
*/

async function connect() {
    await mongo_client.connect();

    console.log('Connected to MongoDB');

    if (fs.existsSync('./data/polldata.json')) {
        manager.pollData = JSON.parse(fs.readFileSync('./data/polldata.json', 'utf8'));
    }

    payments.ready();

    manager.on('./data/pollData', function (pollData) {
        fs.writeFile('./data/polldata.json', JSON.stringify(pollData), function (err) {
            if (err) {
                console.log('Error writing pollData: ' + err);
            }
        });
    });

    client.logOn({
        accountName: config.account.accountName,
        password: config.account.password,
        twoFactorCode: SteamTotp.generateAuthCode(config.account.sharedSecret)
    });
}



/*
    Basic events etc.
*/

client.on('loggedOn', () => {
    payments.sendNotification('Bot is now online.');
})


client.on('error', (err) => {
    payments.sendError('Error occurred:', err);
})


client.on('webSession', function (sessionID, cookies) {
    manager.setCookies(cookies, function (err) {
        if (err) {
            console.log(err);
            process.exit(1);
        }

        console.log("Cookies set");
    })

    community.setCookies(cookies)
    getKeysInStock()

    setInterval(() => {
        getKeysInStock()
    }, 50_000);
})


connect().catch((err) => {
    payments.sendError('Failed connecting:', err);
});


app.listen(config.http.port, (socket) => {
    if (socket) {
        console.log("HTTP server is listening on port " + config.http.port);
    }
})


process.on("uncaughtException", (err) => {
    payments.sendError("Uncaught exception:", err);
})