const config = require('./config.js');

(async () => {
    try {
        balances = await(await fetch(`https://api.nowpayments.io/v1/balance`, {
            headers: { 'x-api-key': config.payments.nowPayments.api },
            redirect: 'follow'
        })).json();
    } catch (error) {
        console.error("Error fetching balances:", error);
    }

    console.log("Balances:", balances);
})();