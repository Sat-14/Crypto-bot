LS.Color.add("main", "#FFAA32");


let loggedIn = false;

const estimator_cache = new Map();

const bot = LS.Reactive.wrap("bot", {
    name: "TF2Keys.trade",
    connected: false,
    load_text: "Almost there...<br>(If it never loads, the bot may be down - please refresh in a few minutes)",
});

const user = LS.Reactive.wrap("user", {});

const exchange = LS.Reactive.wrap("exchange", {
    type: "buy",
});

const mainTabs = new LS .Tabs("main", {
    selector: ".page",
    styled: false,
    list: false,
    mode: null
});

const transferTabs = new LS.Tabs("#transfer-tabs", {
    selector: null,
    mode: null
});

const purchaseTabs = new LS.Tabs("#exchange-tabs", {
    selector: null,
    mode: null
});


transferTabs.add("buy", null, {
    title: "Buy"
});

transferTabs.add("sell", null, {
    title: "Sell"
});

purchaseTabs.add("buy", null, {
    title: "Buy"
});

purchaseTabs.add("sell", null, {
    title: "Sell"
});

transferTabs.renderList();
purchaseTabs.renderList();





;(async function main (){
    LS.Color.setAccent("main");

    const estimateContainer = O("#transfer-tabs");
    const exchangeContainer = O("#exchange-tabs");
    const sendingContainer = estimateContainer.get(".sending");
    const receivingContainer = estimateContainer.get(".receiving");

    const cryptoSelector = [N("select", {
        id: "currency"
    }), N("img", {
        src: "https://nowpayments.io/images/coins/ltc.svg",
        draggable: false,
        height: "45",
        alt: "Crypto currency"
    })];

    const currencySelect = cryptoSelector[0];
    const currencyIcon = cryptoSelector[1];

    const sendInput = estimateContainer.get(".sending input");
    const receiveInput = estimateContainer.get(".receiving input");
    const exchangeInput = exchangeContainer.get("input");

    const depositAmountInput = O("#deposit_amount");
    const withdrawAmountInput = O("#withdraw_amount");

    const tradelinkInput = O("#tradelink");

    let ws;

    const /*enum*/ RECALCULATE_TARGETS = {
        SEND: 0,
        RECEIVE: 1,
        CURRENCY: 2
    };

    function request(path, options){
        return fetch(api + path, {
            ...options,
            credentials: "include"
        });
    }

    async function estimate(currency){
        if(estimator_cache.has(currency)) {
            const cache = estimator_cache.get(currency);
            if(Date.now() - cache.time < 45000) {
                return cache.value;
            }
        }

        const estimate_request = await request("/estimator?currency=" + currency);

        if(!estimate_request.ok) {
            throw new Error("Failed to fetch estimator");
        }

        const value = parseFloat(await estimate_request.text());

        estimator_cache.set(currency, {value, time: Date.now()});
        return value;
    }

    let recalculateTimeout = null;
    let recalculateTarget = RECALCULATE_TARGETS.SEND;

    function recalculate(timeout, target){
        if(recalculateTimeout) {
            clearTimeout(recalculateTimeout);
        }

        recalculateTarget = target;

        if(!timeout) {
            return updateEstimate();
        }

        recalculateTimeout = setTimeout(updateEstimate, timeout || 0);
    }

    async function updateEstimate(){
        const tokenPrice = await estimate(currencySelect.value);

        let sendAmount = parseFloat(sendInput.value) || 0;
        let receiveAmount = parseFloat(receiveInput.value) || 0;

        const buying = transferTabs.activeTab === "buy";
        const money_amount = tokenPrice * (buying? sendAmount: receiveAmount);
        const keys_amount = buying? receiveAmount: sendAmount;

        const price = buying? prices.buy: prices.sell;

        let keys_estimate;
        let money_estimate;

        // exchange.price = money_amount.toFixed(2);
        // exchange.fee = (money_amount * (prices.fee / 100)).toFixed(2);
        // exchange.total = (money_amount + + exchange.fee).toFixed(2);

        console.log(recalculateTarget, buying, sendAmount, receiveAmount, money_amount, keys_amount);
        
        if(recalculateTarget === RECALCULATE_TARGETS.SEND) {
            keys_estimate = (money_amount * tokenPrice) / price;
            receiveInput.value = keys_estimate;
            return;
        }

        if(recalculateTarget === RECALCULATE_TARGETS.RECEIVE) {
            money_estimate = (keys_amount * price) / tokenPrice;
            sendInput.value = money_estimate;
            return;
        }

        if(recalculateTarget === RECALCULATE_TARGETS.CURRENCY) {
            keys_estimate = (money_amount * tokenPrice) / price;
            money_estimate = (keys_amount * price) / tokenPrice;
            sendInput.value = money_estimate;
            receiveInput.value = keys_estimate;
            return;
        }
    }

    function updateExchangeEstimate(){
        const value = parseFloat(exchangeInput.value) || 0;

        exchange.total = (exchange.unit_price * value).toFixed(2);

        let allowed = value > 0 && (exchange.type === "buy"? (value <= prices.stock): (value <= 450));

        exchangeContainer.get("button").disabled = !allowed;
        exchangeInput.setAttribute("ls-accent", allowed? "main": "red");
    }

    const transactionElements = new Map;

    function renderTransaction(transaction){
        const container = transactionElements.get(transaction._id) || N("tr");

        container.setAttribute("ls-accent", {
            failed: "red",
            rejected: "red",
            completed: "green",
            finished: "green",
            canceled: "white",
            expired: "white",
        }[transaction.status] || "main");

        transactionElements.set(transaction._id, container);

        container.clear();
        container.add([
            N("td", transaction._id),
            N("td", transaction.type),
            N("td", transaction.status),
            N("td", Number(transaction.amount).toFixed(2)),
            N("td", transaction.difference? Number(transaction.difference).toFixed(2): "--"),
            N("td", new Date(transaction.timestamp).toLocaleString()),
        ]);

        return container;
    }

    async function fetchHistory(){
        const history = await(await request("/history")).json();

        for(const transaction of history.transactions) {
            O("#transactions tbody").add(renderTransaction(transaction));
        }
    }

    function openSocket(){
        ws = new WebSocket(api.replace("http", "ws") + "/");

        ws.addEventListener("open", function() {
            console.log("WebSocket connection opened");
            bot.connected = true;
        });

        ws.addEventListener("message", function(event) {
            const data = JSON.parse(event.data);

            switch(data.type) {
                case "patch":
                    for(const key in data) {
                        const patch = data[key];

                        switch(key) {
                            case "prices":
                                for(const property in patch) {
                                    prices[property] = patch[property];
                                }
                                break;

                            case "bot":
                                for(const property in patch) {
                                    bot[property] = patch[property];
                                }
                                break;

                            case "user":
                                for(const property in patch) {
                                    const value = patch[property];
                                    user[property] = typeof value === "number"? Number(value.toFixed(2)): value;
                                }
                                break;
                        }
                    }
                    break;

                case "new_transaction": case "update_transaction":
                    const element = renderTransaction(data.transaction)
                    const isNew = data.type === "new_transaction";

                    if(isNew) {
                        O("#transactions tbody").add(element);
                    }

                    LS.Toast.show((isNew? "New transaction: ": "Transaction updated: ") + data.transaction._id, {
                        timeout: 2000
                    });
                    break;
            }
        });

        ws.addEventListener("close", function() {
            console.log("WebSocket connection closed");
            setTimeout(openSocket, 5000);
            bot.connected = false;
        });
        
        ws.addEventListener("error", function(error) {
            console.error("WebSocket error: ", error);
            bot.connected = false;
        });
    }

    const testMode = location.origin.endsWith("test");
    const api = testMode? "http://steambot.test:52000": "https://tf2keys.trade:52000";

    try {
        const profile = await(await request("/profile")).json();
        if(!profile || profile.error) throw new Error("No profile");

        loggedIn = true;

        for(const key in profile) {
            user[key] = profile[key];
        }

        if(user.tradelink) {
            tradelinkInput.value = user.tradelink;
        }
    } catch(e) {
        console.error(e);
        loggedIn = false;
    }

    const currencies = await(await fetch("/assets/currencies.json?remove=nfa")).json();
    const prices = LS.Reactive.wrap("prices", await(await request("/prices")).json());

    if(loggedIn){
        O("#steam-login").style.display = "none";
        O("#profile-user").style.display = "flex";
        
        fetchHistory();
        openSocket();
    } else {
        // O("#menu-toggle").classList.remove("show-600");
        // O("#menu-toggle").style.display = "none";
    }
    
    O("#menu-toggle").on("click", function() {
        document.body.classList.toggle("sidebar-open");
    });
    
    document.body.style.setProperty("--sidebar-width", `100px`);
    
    addEventListener("click", event => {
        if(document.body.classList.contains("sidebar-open") && !event.target.closest("#sidebar") && !event.target.closest("#menu-toggle")) {
            document.body.classList.remove("sidebar-open");
        }
    })

    window.prices = prices;
    window.currencies = currencies;
    
    const options = [];
    for(let currency of currencies) {
        if(!currency.enable) continue;

        options.push(N("option", {
            value: currency.code,
            inner: currency.name || currency.code
        }));
    }

    options.sort((a, b) => {
        const aName = a.value.toLowerCase();
        const bName = b.value.toLowerCase();

        if(aName < bName) return -1;
        if(aName > bName) return 1;
        return 0;
    }).forEach(option => {
        currencySelect.add(option);
    });
    
    currencySelect.value = "LTC";

    currencySelect.on("change", function() {
        const selected = currencies.find(c => c.code == this.value);
        currencyIcon.src = `https://nowpayments.io/${selected.logo_url}`;

        if(mainTabs.activeTab === "page-homepage") {
            recalculate(50, RECALCULATE_TARGETS.CURRENCY);
        }
    });

    sendInput.on("input", function() {
        recalculate(500, RECALCULATE_TARGETS.SEND);
    });

    receiveInput.on("input", function() {
        recalculate(500, RECALCULATE_TARGETS.RECEIVE);
    });

    exchangeInput.on("input", function() {
        updateExchangeEstimate();
    });

    depositAmountInput.on("input", function() {
        const amount = parseFloat(this.value) || 0;
        const feePercent = prices.fee / 100;
        const fee=Math.round((amount*feePercent)*100)/100;
        const total = Math.round((amount-fee)*100)/100;
        

        depositAmountInput.setAttribute("ls-accent", amount >= prices.minimum_order? "main": "red");
        O("#deposit_button").disabled = amount < prices.minimum_order;
        
        exchange.deposit_fee = fee.toFixed(2);
        exchange.deposit_total = total.toFixed(2);
    })

    withdrawAmountInput.on("input", function() {
        const amount = parseFloat(this.value) || 0;
        // Calculate fee with proper rounding
    const feePercent = prices.fee / 100;
    // Round to exactly 2 decimal places
    const fee = Math.round((amount * feePercent) * 100) / 100;
    // Calculate total by subtracting the rounded fee
    const total = Math.round((amount - fee) * 100) / 100;
        

        const allowed = user.balance >= amount && amount >= 1;
        withdrawAmountInput.setAttribute("ls-accent", allowed? "main": "red");
        O("#withdraw_button").disabled = !allowed;
        
        exchange.withdraw_fee = fee.toFixed(2);
        exchange.withdraw_total = total.toFixed(2);
    })

    O("#exchangeButton").on("click", function() {
        if(!user.tradelink) {
            changePage("profile");

            return LS.Toast.show("You need to set your tradelink before making a trade!", {
                timeout: 2000
            });
        }
        
        const amount = parseFloat(exchangeInput.value) || 0;

        if(!amount || amount <= 0) {
            return LS.Toast.show("Please enter a valid amount", {
                timeout: 2000
            });
        }

        bot.load_text = "Creating your trade offer...<br>(This may take a few seconds)";
        mainTabs.set("page-loader");

        request("/" + exchange.type + "?amount=" + amount).then(async response => {
            if(!response.ok) {
                mainTabs.set("page-exchange");
                throw new Error("Failed to create exchange");
            }

            const data = await response.json();

            if(data.error) {
                alert(data.error);
                mainTabs.set("page-exchange");
                return;
            }

            alert("The trade offer was sucessfully sent to you - offer ID: " + data.offer_id + "! Check your Steam notifications to complete the trade.");
            mainTabs.set("page-exchange");
        }).catch(error => {
            console.error(error);
            mainTabs.set("page-exchange");

            LS.Toast.show("Failed to start exchange", {
                timeout: 2000
            });
        });
    });

    O("#deposit_button").on("click", function() {
        bot.load_text = "Creating a deposit transaction...";
        mainTabs.set("page-loader");

        request("/deposit?amount=" + (parseFloat(depositAmountInput.value) || 0)).then(async response => {
            if(!response.ok) {
                mainTabs.set("page-deposit");
                return alert("Sorry, your deposit couldnt be created. Please try again later.");
            }

            const data = await response.json();

            if(data.error) {
                alert(data.error);
                return;
            }

            open(data.url);
            mainTabs.set("page-deposit");
        }).catch(error => {
            console.error(error);
            mainTabs.set("page-deposit");

            LS.Toast.show("Failed to start deposit", {
                timeout: 2000
            });
        });
    });

    O("#withdraw_button").on("click", function() {
        bot.load_text = "Creating a withdraw transaction...<br>(This may take a few seconds)";
        mainTabs.set("page-loader");
        let amount = parseFloat(withdrawAmountInput.value) || 0;
    
    // If they're trying to withdraw very close to their balance, just use the exact balance
    const epsilon = 0.01;
    if (Math.abs(user.balance - amount) < epsilon) {
        amount = user.balance;
    }
        
        request(`/withdraw?amount=${parseFloat(withdrawAmountInput.value) || 0}&address=${encodeURIComponent(O("#withdraw_address").value)}&currency=${currencySelect.value}`).then(async response => {
            if(!response.ok) {
                mainTabs.set("page-withdraw");
                return alert("Sorry, your withdraw couldnt be created. Please try again later.");
            }

            const data = await response.json();

            if(data.error) {
                alert(data.error);
                return;
            }

            withdrawAmountInput.value = 0;
            withdrawAmountInput.dispatchEvent(new Event("input"));

            alert("Your withdraw was sucessfully created - transaction ID: " + data.id + "! Check the History tab for updates.");
            mainTabs.set("page-history");
        }).catch(error => {
            console.error(error);
            mainTabs.set("page-withdraw");

            LS.Toast.show("Failed to start withdraw", {
                timeout: 2000
            });
        });
    });

    const tradelink_regex = /^https:\/\/steamcommunity\.com\/tradeoffer\/new\/\?partner=\d+&token=[a-zA-Z0-9_-]+$/;

    tradelinkInput.on("input", function() {
        const isValid = tradelink_regex.test(this.value);

        if(tradelinkInput._timeout) {
            clearTimeout(tradelinkInput._timeout);
        }

        this.setAttribute("ls-accent", isValid ? "main" : "red");
        user.tradelink_setting_message = isValid ? "Saving...": "Invalid tradelink";

        if(isValid) {
            this.disabled = true;

            request("/set_tradelink?tradelink=" + encodeURIComponent(this.value)).then(response => {

                this.disabled = false;

                if(!response.ok) {
                    throw new Error("Failed to save tradelink");
                }

                user.tradelink = this.value;
                user.tradelink_setting_message = "Saved.";

                LS.Toast.show("Your tradelink was successfully saved.", {
                    timeout: 2000
                })

                tradelinkInput._timeout = setTimeout(() => {
                    user.tradelink_setting_message = "";
                }, 2000);

            }).catch(error => {
                console.error(error);
                user.tradelink_setting_message = "Failed to save tradelink";
                this.disabled = false;
            });
        }
    });

    transferTabs.on("changed", function(id) {
        const cryptoField = estimateContainer.get(".exchange-currency.crypto");
        const keysField = estimateContainer.get(".exchange-currency.keys");

        switch(id) {
            case "buy":
                receivingContainer.add(keysField);
                sendingContainer.add(cryptoField);

                const a = sendInput.value;
                sendInput.value = receiveInput.value;
                receiveInput.value = a;
                break;
            case "sell":
                receivingContainer.add(cryptoField);
                sendingContainer.add(keysField);

                const b = receiveInput.value;
                receiveInput.value = sendInput.value;
                sendInput.value = b;
                break;
        }
    });

    purchaseTabs.on("changed", function(id) {
        exchange.type = id;
        exchange.explanation = id === "buy"? "you send": "you receive";
        exchange.unit_price = id === "buy"? prices.buy: prices.sell;
        exchange.info = id === "buy"? "You are purchasing keys with your on-site balance. To get more balance, you can either sell some keys or add balance in the deposit tab!": "You receive on-site balance for the keys you sell, which you can later withdraw to your wallet in the transfer tab!";
        purchaseTabs.element.get(".stock-row").style.display = id === "buy"? "table-row": "none";
        updateExchangeEstimate();
    });

    mainTabs.on("changed", function(id) {
        const sidebarSelectedItem = O("#sidebar .selected");
        const sidebarItem = O("#sidebar div[data-link='" + id.replace('page-', "") + "']");

        const tab = mainTabs.tabs.get(id);

        if(sidebarSelectedItem) sidebarSelectedItem.classList.remove("selected");
        if(sidebarItem) sidebarItem.classList.add("selected");

        if (id === "page-homepage") {
            history.replaceState(null, "", "/");
        } else {
            if(!loggedIn) {
                return steamLogin();
            }

            history.replaceState(null, "", "/" + id.replace("page-", ""));
        }

        switch(id) {
            case "page-withdraw": case "page-homepage":
                const container = tab.element.get(".crypto");

                if(container) {
                    container.add(cryptoSelector);
                }
                break;
        }
    });

    O("#page-loader").classList.remove("tab-active");

    transferTabs.set(0);
    purchaseTabs.set(0);

    let page = location.pathname.replace(/^\//, "").replace(/\/$/, "").replace(/page-/, "");
    if(page === "loader") page = "homepage";

    changePage(page || "homepage");
})();



function changePage(page) {
    if(page instanceof HTMLElement) {
        page = page.dataset.link;
    }

    if(!loggedIn && page !== "homepage") {
        return steamLogin();
    }

    let key = "page-" + page;
    mainTabs.set(!mainTabs.tabs.has(key)? "page-404": "page-" + page);
}

function steamLogin() {
    const url = new URL("https://steamcommunity.com/openid/login");
    url.searchParams.set("openid.ns", "http://specs.openid.net/auth/2.0");
    url.searchParams.set("openid.mode", "checkid_setup");
    url.searchParams.set("openid.return_to", location.origin + ":52000/steam_login");
    url.searchParams.set("openid.realm", location.origin);
    url.searchParams.set("openid.identity", "http://specs.openid.net/auth/2.0/identifier_select");
    url.searchParams.set("openid.claimed_id", "http://specs.openid.net/auth/2.0/identifier_select");

    window.location.href = url.toString();
}

function toggleTabs(){
    transferTabs.set(transferTabs.activeTab === "sell"? "buy": "sell");
}
