const crypto = require('crypto');
const speakeasy = require('speakeasy');
const { ObjectId } = require('mongodb');

const profileExtractor = require('./steam-profile-extract');

const BINANCE_BASE_URL = "https://api.binance.com";

const PAYMENT_PROCESSORS = {
    NOW_PAYMENTS: 0,
    NOWPAYMENTS: 0,
    DEFAULT: 0,
    // BINANCE: 1,
    // BINANCE_C2C: 1,
    // BINANCE_PAY: 2,
}


let config, bot, Prices, Currencies, EstimateCache = new Map();

class AbstractPaymentProcessor {
    constructor(config, client) {
        config = config;
        this.client = client;

        this.last_token_update = 0;
        this.nowpayments_token_cache = null;
    }

    async createTransaction(data) {
        const steamID_64 = typeof data.steamID !== "string"? (data.steamID_64 || data.steamID.getSteamID64()): data.steamID;

        delete data.steamID;
        delete data.steamID_64;

        data.steamID = steamID_64;
        data.timestamp = new Date();
        data.status = data.status || "pending";
        if (data.amount) {
    // Store with 3 decimal precision
    data.amount = parseFloat(parseFloat(data.amount).toFixed(3));
}

if (typeof data.difference !== "undefined") {
    // Store with 3 decimal precision
    data.difference = parseFloat(parseFloat(data.difference).toFixed(3));
} else if (data.amount) {
    data.difference = data.amount;
}
    
        const result = await bot.transactions_collection.insertOne(data);
        data._id = result.insertedId;

        bot.ws_publish(steamID_64, {
            type: "new_transaction",
            transaction: data
        })

        return result.insertedId;
    }
    
    /**
     * Gets a transaction from the database
     * @param {String | ObjectId} transactionId
     * @returns {Promise<UpdateResult>}
     */
    
    async getTransaction(transactionId) {
        return await bot.transactions_collection.findOne({
            _id: new ObjectId(transactionId)
        });
    }
    
    /**
     * Updates a transaction in the database
     * @param {String | ObjectId} transactionId
     * @returns {Promise<UpdateResult>}
     */
    
    async updateTransaction(transactionId, data) {
        const result = await bot.transactions_collection.findOneAndUpdate({
            _id: new ObjectId(transactionId)
        }, {
            $set: data
        }, {
            upsert: true,
            returnDocument: "after"
        });

        console.log("Updated transaction:", result);

        if (result?.steamID) {
            bot.ws_publish(result.steamID, {
                type: "update_transaction",
                id: transactionId,
                transaction: result
            });
        }

        return result;
    }

    async createInvoice(orderID, amount, callback, provider = PAYMENT_PROCESSORS.NOW_PAYMENTS) {
        try {
            // Calculate with full precision
            const calculatedAmount = parseFloat(amount);
            let response;
            
            switch (provider) {
                case PAYMENT_PROCESSORS.NOW_PAYMENTS:
                    response = await fetch('https://api.nowpayments.io/v1/invoice', {
                        method: "POST",
                        body: JSON.stringify({
                            price_amount: calculatedAmount.toFixed(3),
                            price_currency: "usd",
                            ipn_callback_url: config.http.server_url + config.payments.nowPayments.ipn_callback,
                            is_fee_paid_by_user: false,
                            // is_fixed_rate: true,
                            order_id: orderID.toString(),
                        }),

                        headers: { 'x-api-key': config.payments.nowPayments.api, "Content-Type": "application/json" },
                        redirect: 'follow'
                    });

                    const response_data = await response.json();
    
                    if (response.ok) {
                        callback(null, response_data)
                    } else throw {response, response_data};
                    break;

                case PAYMENT_PROCESSORS.BINANCE:
                    // order history method
    
                    if (response.status === 'FILLED') {
                        callback(null, response);
                    } throw { response };
            }
        } catch (error) {
            callback(error);
            this.sendError("Error creating invoice:", error);
            this.updateTransaction(orderID, { status: "failed" });
            // this.client.chatMessage(steamID, 'Couldn\'t create a deposit. Please try again later.');
        }
    }

    async createWithdrawal({steamID_64, amount, currency, address, onFailed, processing, updated, provider = PAYMENT_PROCESSORS.NOW_PAYMENTS, network = "BSC"}) {
        let response;

        // Calculate with full precision
        const calculatedAmount = parseFloat(amount);
        // Format for storage
        const diff = -calculatedAmount;
        const updateResult = await bot.increaseBalanceOf(steamID_64, diff.toFixed(3));

        if (updateResult.modifiedCount === 0) {
            return onFailed(`Sorry, failed to process your withdrawal. Please try again.`);
        }

        const transactionId = await this.createTransaction({ 
    steamID_64, 
    type: "withdrawal", 
    amount, 
    difference: diff, 
    status: "pending",
    currency,
    address,
    created_at: new Date()
     });
     // Set up a withdrawal timeout to automatically check status if no callback received
setTimeout(async () => {
    const transaction = await this.getTransaction(transactionId);
    if (transaction && transaction.status === "pending") {
        this.sendNotification(`Checking withdrawal ${transactionId} that has been pending for too long`);
        try {
            this.sendError(`Withdrawal ${transactionId} stuck in pending state`);
        } catch (err) {
            this.sendError(`Error checking withdrawal ${transactionId}:`, err);
        }
    }
}, 30 * 60 * 1000); // 30 minutes timeout

        const failed = (error) => {
            this.refund_withdrawal(transactionId);
            this.sendError('! Failed to create withdrawal:', JSON.stringify(error, null, 2));
            onFailed(error);
        }

        try {
            switch (provider) {
                case PAYMENT_PROCESSORS.NOW_PAYMENTS:

                    let balances;

                    // Fetch balances from NOWPayments
                    try {

                        balances = await(await fetch(`https://api.nowpayments.io/v1/balance`, {
                            headers: { 'x-api-key': config.payments.nowPayments.api },
                            redirect: 'follow'
                        })).json();

                    } catch (error) {
                        console.error("Error fetching balances:", error);
                    }

                    // Questionable API design...
                    if (!balances || balances.status === false || balances.message) {
                        failed("Failed to convert the amount to the desired currency.");
                        this.sendError("Failed to fetch balances:", balances);
                        return;
                    }

                    async function estimateValue(amount){
                        let estimate;

                        try {

                            estimate = await(await fetch(`https://api.nowpayments.io/v1/estimate?amount=${amount}&currency_from=usd&currency_to=${currency}`, {
                                headers: { 'x-api-key': config.payments.nowPayments.api },
                                redirect: 'follow'
                            })).json();

                        } catch (error) {
                            console.error("Error fetching estimate value:", error);
                            return null;
                        }
    
                        if (!estimate || !estimate.estimated_amount) {
                            failed("Failed to estimate the amount of the desired currency.");
                            return;
                        }

                        return Number(estimate.estimated_amount);
                    }

                    let from = Object.keys(balances)
                        .filter(key => key.toLowerCase().startsWith("usdt") || key.toLowerCase().startsWith("usdc"))
                        .reduce((max, key) => balances[key].amount > (balances[max]?.amount || 0) ? key : max, null);

                    console.log("Balances:", balances, ", highest USD stablecoin:", from);

                    if(balances[currency.toLowerCase()] && balances[currency.toLowerCase()].amount >= await estimateValue(amount)) {
                        from = currency.toLowerCase();
                    }
                    
                    const feePercent = Prices.fee / 100;
                    const calculatedFee = calculatedAmount * feePercent;
                    const finalAmount = calculatedAmount - calculatedFee;

                    this.convert(amount, from, currency, async (error, result) => {
                        // We can actually kinda ignore the convert error here, since we can still at least try to use the original currency.
                        // if (error) {
                        //     failed(error);
                        //     return;
                        // }

                        this.sendNotification(`Withdrawing ${amount} ${from} to ${address} (${currency})`);

                        response = await fetch('https://api.nowpayments.io/v1/payout', {
                            method: "POST",
        
                            body: JSON.stringify({
                                ipn_callback_url: config.http.server_url + config.payments.nowPayments.ipn_callback,

                                withdrawals: [
                                    {
                                        address,
                                        currency,
                                        amount: 0,
                                        fiat_amount: finalAmount.toFixed(3),
                                        fiat_currency: "usd",
                                        unique_external_id: transactionId.toString(),
                                    }
                                ]
                            }),
        
                            headers: { 'x-api-key': config.payments.nowPayments.api, Authorization: "Bearer " + await this.getToken(PAYMENT_PROCESSORS.NOW_PAYMENTS), "Content-Type": "application/json" },
                            redirect: 'follow'
                        });
        
                        const response_data = await response.json();

                        if (response.ok) {
                            const id = String(response_data.id);
    this.verify_withdrawal(id);
    
    // Store the batch_withdrawal_id in the transaction record
    if (response_data.id) {
        await this.updateTransaction(transactionId, { 
            batch_withdrawal_id: response_data.id
        });
    }
    
    bot.userTransactionLock.set(steamID_64, transactionId);
    processing(id);
                            // Add this code after processing(id);
bot.ws_publish(steamID_64, {
    type: "update_transaction",
    id: transactionId,
    transaction: await this.getTransaction(transactionId)
});
                        } else failed ({ response, response_data });
                    });
                    break;
                
                case PAYMENT_PROCESSORS.BINANCE:
                    const params = {
                        coin: "USDT",
                        address: address,
                        amount: amount,
                        network,
                        timestamp: Date.now(),
                    };
                
                    const queryString = new URLSearchParams(params).toString();

                    const signature = crypto
                        .createHmac("sha256", config.payments.binance.api_secret)
                        .update(queryString)
                        .digest("hex");

                    try {
                        const response = await fetch(`${BINANCE_BASE_URL}/sapi/v1/localentity/withdraw/apply?${queryString}&signature=${signature}`, {
                            method: "POST",
                            headers: { "X-MBX-APIKEY": config.payments.binance.api_key }
                        });

                        const responseData = await response.json();

                        if (responseData.code) {
                            failed(responseData);
                        } else {
                            updated(responseData.id, { status: "finished", amount: amount, currency, address });
                        }
                    } catch (error) {
                        failed(error);
                    }
                    break;
            }
        } catch (error) {
            failed(error);
        }
    }


    async verify_withdrawal(invoice_id) {
    try {
        const response = await fetch(`https://api.nowpayments.io/v1/payout/${invoice_id}/verify`, {
            method: "POST",
            body: JSON.stringify({
                verification_code: speakeasy.totp({
                    secret: config.payments.nowPayments.otp_secret,
                    encoding: 'base32',
                })
            }),
            headers: { 
                'x-api-key': config.payments.nowPayments.api, 
                Authorization: "Bearer " + await this.getToken(PAYMENT_PROCESSORS.NOW_PAYMENTS), 
                "Content-Type": "application/json" 
            },
            redirect: 'follow'
        });

        const data = await response.json();

        if (!response.ok) {
            this.sendError(`Failed to verify withdrawal ${invoice_id}:`, data);
            return { success: false, error: data };
        }

        this.sendNotification(`Successfully verified withdrawal with ID #${invoice_id}`);
        return { success: true, data };
    } catch (error) {
        this.sendError(`Exception verifying withdrawal ${invoice_id}:`, error);
        return { success: false, error };
    }
}


    async refund_withdrawal(transactionId) {
        const transaction = await this.getTransaction(transactionId);
        if (!transaction || transaction.refunded) return;

        const steamID_64 = transaction.steamID;
        const difference = transaction.difference;

        await bot.increaseBalanceOf(steamID_64, Math.abs(difference));
        await this.updateTransaction(transactionId, { refunded: true, status: "failed" });
    }


    async getToken(provider = PAYMENT_PROCESSORS.NOW_PAYMENTS) {
        switch (provider) {
            case PAYMENT_PROCESSORS.NOW_PAYMENTS:
                if (this.nowpayments_token_cache && Date.now() - this.last_token_update < 240000) return this.nowpayments_token_cache;

                const response = await fetch("https://api.nowpayments.io/v1/auth", {
                    method: 'POST',

                    headers: {
                        "Content-Type": "application/json"
                    },

                    body: JSON.stringify({
                        "email": config.payments.nowPayments.email,
                        "password": config.payments.nowPayments.password
                    }),

                    redirect: 'follow'
                });

                let data = await response.json();

                return this.nowpayments_token_cache = data.token;
        }
    }

    async checkDeposits() {
        if (!config.payments.binance.enabled) return;

        const timestamp = Date.now();
        const queryString = `timestamp=${timestamp}&startTime=${timestamp - 120000}&endTime=${timestamp}`;

        const signature = crypto
            .createHmac('sha256', config.payments.binance.api_secret)
            .update(queryString)
            .digest('hex');

        try {
            const response = await fetch(`${BINANCE_BASE_URL}/sapi/v1/pay/transactions?${queryString}&signature=${signature}`, {
                headers: { "X-MBX-APIKEY": config.payments.binance.api_key }
            });

            const depositHistory = await response.json();

            if (depositHistory.message !== "success") throw depositHistory;

            for (let deposit of depositHistory.data) {
                const amount = parseFloat(deposit.amount);

                if (deposit.note && amount > 0) {
                    const steamID_64 = deposit.note;

                    if(deposit.currency !== 'USDT') {
                        console.log(`Invalid currency for deposit: ${deposit.currency}`);
                        continue;
                    }

                    // Check if the deposit has already been processed
                    const isProcessed = await bot.deposit_unique_collection.findOne({ uid: deposit.transactionId });
                    if (!isProcessed) {
                        await bot.deposit_unique_collection.insertOne({ uid: deposit.transactionId, timestamp: Date.now() });

                        if(bot.processDeposit) {
                            bot.processDeposit(steamID_64, amount, deposit.transactionId);
                        }
                    }
                }
            }
        } catch (error) {
            this.sendError('Failed to fetch deposit history:', error);
            return;
        }
    }
// Add this new function to help manage stuck withdrawals
async checkPendingWithdrawals() {
    try {
        const pendingWithdrawals = await bot.transactions_collection.find({
            type: "withdrawal",
            status: "pending",
            created_at: { $lt: new Date(Date.now() - 24 * 60 * 60 * 1000) } // Older than 24 hours
        }).toArray();
        
        if (pendingWithdrawals.length > 0) {
            this.sendNotification(`Found ${pendingWithdrawals.length} pending withdrawals older than 24 hours`);
            
            for (const withdrawal of pendingWithdrawals) {
                // Log for manual investigation
                this.sendError(`Stale withdrawal detected: ${withdrawal._id}`, withdrawal);
                
                // Optional: You could implement automatic refund for very old withdrawals
                // await this.refund_withdrawal(withdrawal._id);
            }
        }
    } catch (error) {
        this.sendError("Error checking pending withdrawals:", error);
    }
}
    ready() {
    bot.deposit_unique_collection = bot.db.collection('processedDeposits');
    bot.transactions_collection = bot.db.collection('transactions');
    
    setInterval(() => this.checkDeposits(), config.payments.binance.check_interval);
    // Run the pending withdrawal check every 6 hours
    setInterval(() => this.checkPendingWithdrawals(), 6 * 60 * 60 * 1000);
    
    this.checkDeposits();
}

    sendWebhook(url, message, options = {}) {
        if (!url) return;

        fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                content: typeof message === "string"? message: message.map(data => { try { return typeof data === "object"? "\n```json\n" + JSON.stringify(data, null, 4) + "\n```\n": String(data) } catch { return String(data) } }).join(" "),
                ...options
            })
        }).then(response => {
            if (!response.ok) {
                console.error("Failed to send webhook:", response.statusText);
            }
        }
        ).catch(error => {
            console.error("Failed to send webhook:", error);
        });
    }

    sendNotification(...message) {
        console.log("Notification:", ...message);
        this.sendWebhook(config.discord.webhook_url, message);
    }

    sendError(...message) {
        console.log("Error:", ...message);
        this.sendWebhook(config.discord.webhook_errors_url, message);
    }

    chatLog(steamID_64, message, commandHandler) {
        const log = `Message from ${steamID_64}: ${message}`;
        console.log(log);

        profileExtractor(steamID_64).then((extract) => {
            if (!extract) {
                this.sendWebhook(config.discord.webhook_chat_url, log);
                return;
            }

            const options = {
                username: extract("steamID"),
                avatar_url: extract("avatarMedium")
            }

            if(commandHandler) {
                options.embeds = [{
                    title: "Executed command",
                    description: commandHandler.name,
                    color: 0x00FF00
                }];
            }

            this.sendWebhook(config.discord.webhook_chat_url, message, options);
        });
    }

    /**
     * Get the estimated value of a currency
     * @param {Number} amount
     * @param {String} from_currency
     * @param {String} to_currency
     * @param {Function} callback
     * @param {Number} provider
     * @returns {Promise<void>}
     */

    async getEstimate(amount, from_currency, to_currency = "usd", callback, provider = PAYMENT_PROCESSORS.NOW_PAYMENTS) {
        if (from_currency.toLowerCase() === to_currency.toLowerCase()) return callback(null, amount);

        if (EstimateCache.has(`${from_currency}-${to_currency}`)) {
            const cachedValue = EstimateCache.get(`${from_currency}-${to_currency}`);

            if (cachedValue && Date.now() - cachedValue.timestamp < 120000) {
                return callback(null, cachedValue.value);
            }
        }

        const request = await fetch(`https://api.nowpayments.io/v1/estimate?amount=${amount}&currency_from=${from_currency}&currency_to=${to_currency}`, {
            method: "GET",
            headers: { 'x-api-key': config.payments.nowPayments.api }
        });

        if (request.ok) {
            const data = await request.json();

            if (data && typeof data.estimated_amount) {
                EstimateCache.set(`${from_currency}-${to_currency}`, {value: data.estimated_amount, timestamp: Date.now()});
                callback(null, data.estimated_amount);
            } else {
                callback(data);
            }
        } else {
            callback(await request.text());
        }
    }


    /**
     * Currency conversion.
     * Currenlly only implemented for NOWPayments
     * @param {*} amount
     * @param {*} from_currency
     * @param {*} to_currency
     * @param {*} callback
     */
    async convert(amount, from_currency, to_currency = "usdtbsc", callback, provider = PAYMENT_PROCESSORS.NOW_PAYMENTS) {
        if (from_currency.toLowerCase() === to_currency.toLowerCase()) return callback(null, amount);
    
        const request = await fetch(`https://api.nowpayments.io/v1/conversion`, {
            method: "POST",
            body: JSON.stringify({ amount, from_currency, to_currency: to_currency || "usdtbsc" }),
            headers: { "Authorization": "Bearer " + await this.getToken(PAYMENT_PROCESSORS.NOW_PAYMENTS), "Content-Type": "application/json" }
        })

        let checks = 0;

        const _this = this;
        async function process(request) {
            if (request.ok) {
                const data = await request.json();

                if (data.result && data.result.status !== "REJECTED") {
                    if(data.result.status === "WAITING" || data.result.status === "PROCESSING" || data.result.status === "PENDING" || data.result.status === "AWAITING_APPROVAL") {
                        checks++;

                        if(checks >= 60) {
                            return callback("Conversion took too long. Please try again later.");
                        }

                        setTimeout(async () => {
                            const request = await fetch(`https://api.nowpayments.io/v1/conversion/${data.result.id}`, {
                                headers: { "Authorization": "Bearer " + await _this.getToken(PAYMENT_PROCESSORS.NOW_PAYMENTS) }
                            });

                            process(request);
                        }, 3000);
                    }
                    
                    else if(data.result.status === "FINISHED") callback(null, data.result);
                    else callback(data);
                } else {
                    callback(data);
                }
            } else {
                callback(await request.text());
            }
        }

        process(request);
    }


    /**
     * Get a sub-user custody from NOWPayments
     * @param {*} name steamID_64
     * @returns NowPayments sub-user object
     */

    async nowPaymentsGetSubUser(name) {
        bot.nowpayments_subusers_collection ??= bot.db.collection('subUsers');

        const subUser = await bot.nowpayments_subusers_collection.findOne({ name });

        if(subUser) return subUser;
    
        const response = await fetch('https://api.nowpayments.io/v1/sub-partner/balance', {
            method: 'POST',
            body: JSON.stringify({ name }),
            headers: { Authorization: "Bearer " + await this.getToken(PAYMENT_PROCESSORS.NOW_PAYMENTS), "Content-Type": "application/json" }
        });

        const data = await response.json();
    
        if (response.ok && data.result) {
            this.sendNotification("Added a new sub-user custody on NOWPayments:", data.result);
            await bot.nowpayments_subusers_collection.insertOne(data.result);
            return data.result;
        } else {
            throw data;
        }
    }
}

module.exports = (configref, botref, currenciesref, pricesref) => {
    config = configref;
    bot = botref;

    Currencies = currenciesref;
    Prices = pricesref;

    return { payments: new AbstractPaymentProcessor(bot.client), PAYMENT_PROCESSORS }
};
