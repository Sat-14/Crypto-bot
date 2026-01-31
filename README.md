# Automated Cryptocurrency Trading Platform for Steam Items

A full-stack Node.js application that facilitates automated trading of Steam Mann Co. Supply Crate Keys with integrated cryptocurrency payment processing. The platform features a real-time web interface, Steam bot integration, and multi-currency payment support through NOWPayments.

## Technical Overview

This platform bridges the gap between cryptocurrency payments and Steam item trading, providing users with a secure, automated way to buy and sell Team Fortress 2 keys using various cryptocurrencies.

### Core Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         Client Layer                             │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐      │
│  │  Web Client  │    │  Steam Chat  │    │  Discord     │      │
│  │  (Browser)   │    │  Interface   │    │  Webhooks    │      │
│  └──────────────┘    └──────────────┘    └──────────────┘      │
└─────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Application Server                          │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │              uWebSockets.js HTTP/WS Server                │  │
│  │  ┌────────────┐  ┌────────────┐  ┌──────────────────┐   │  │
│  │  │  REST API  │  │ WebSocket  │  │  Authentication  │   │  │
│  │  │  Endpoints │  │   Layer    │  │  (JWT/OAuth)     │   │  │
│  │  └────────────┘  └────────────┘  └──────────────────┘   │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │                   Business Logic Layer                    │  │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐   │  │
│  │  │   Trading    │  │   Payment    │  │   User       │   │  │
│  │  │   Engine     │  │   Processor  │  │   Manager    │   │  │
│  │  └──────────────┘  └──────────────┘  └──────────────┘   │  │
│  └──────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                      External Services                           │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌──────────┐ │
│  │  MongoDB   │  │   Steam    │  │ NOWPayments│  │  Binance │ │
│  │  Database  │  │    API     │  │     API    │  │   API    │ │
│  └────────────┘  └────────────┘  └────────────┘  └──────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

### Data Flow Diagrams

#### Buy Transaction Flow

```
User Request → Validation → Balance Check → Key Reservation
                                                    │
                                                    ▼
              ┌──────────────────────────────────────────────┐
              │         Sufficient Balance?                  │
              └──────────────────────────────────────────────┘
                      │                        │
                     Yes                      No
                      │                        │
                      ▼                        ▼
           Create Trade Offer        Create Invoice (NOWPayments)
                      │                        │
                      ▼                        ▼
           Send to Steam User          User Pays via Crypto
                      │                        │
                      ▼                        ▼
           User Accepts Trade          Webhook Callback (IPN)
                      │                        │
                      ▼                        ▼
           Deduct Balance              Update Balance → Create Trade Offer
                      │                                         │
                      ▼                                         ▼
           Release Reserved Keys              Same flow as "Yes" path
                      │
                      ▼
           Transaction Complete
```

#### Sell Transaction Flow

```
User Request → Validation → Inventory Check → Stock Limit Check
                                                        │
                                                        ▼
                                         Create Trade Offer (Request Items)
                                                        │
                                                        ▼
                                            Send to Steam User
                                                        │
                                                        ▼
                                            User Accepts Trade
                                                        │
                                                        ▼
                                         Add Balance (Price × Quantity)
                                                        │
                                                        ▼
                                            Transaction Complete
```

#### Withdrawal Flow

```
User Request → Validation → Balance Check → Currency Check
                                                    │
                                                    ▼
                                        Deduct Balance Immediately
                                                    │
                                                    ▼
                          ┌─────────────────────────────────────┐
                          │    Create Payout (NOWPayments)      │
                          └─────────────────────────────────────┘
                                         │              │
                                     Success        Failure
                                         │              │
                                         ▼              ▼
                          Auto-verify with OTP    Refund Balance
                                         │              │
                                         ▼              ▼
                            Webhook Status Updates   Notify User
                                         │
                          ┌──────────────┴──────────────┐
                          │                             │
                    "CONFIRMED"                    "FAILED"
                          │                             │
                          ▼                             ▼
                   User Notified                 Refund Balance
                 Transaction Complete             Notify User
```

## Key Features

### 1. Automated Trading System
- Real-time Steam inventory management
- Automatic trade offer creation and confirmation
- Key reservation system to prevent overselling
- Retry mechanism with exponential backoff for failed trades
- Trade state tracking and validation

### 2. Multi-Currency Payment Processing
- Integration with NOWPayments API for cryptocurrency transactions
- Support for 100+ cryptocurrencies (USDT, BTC, ETH, LTC, etc.)
- Automatic currency conversion
- Invoice generation with IPN callbacks
- Fee calculation and management
- HMAC signature verification for webhook security

### 3. Real-time Communication
- WebSocket implementation for instant updates
- Live balance updates
- Real-time transaction status notifications
- Steam chat bot interface with command system

### 4. Security Features
- JWT-based authentication
- Steam OpenID login integration
- HMAC-SHA512 signature verification for payment webhooks
- 2FA support for withdrawals (TOTP)
- Request validation and sanitization
- User ban system

### 5. Admin Dashboard Capabilities
- Dynamic price adjustment
- Fee configuration
- Stock cap management
- User balance manipulation
- Transaction monitoring
- Ban/unban functionality

## Technology Stack

### Backend
- **Runtime**: Node.js
- **Web Server**: uWebSockets.js (high-performance HTTP/WebSocket server)
- **Database**: MongoDB with native driver
- **Steam Integration**:
  - steam-user (authentication and session management)
  - steam-tradeoffer-manager (trade automation)
  - steamcommunity (community features)
  - steam-totp (two-factor authentication)

### Payment Processing
- **Cryptocurrency**: NOWPayments API
- **Alternative**: Binance Pay integration (commented out)
- **Authentication**: JWT (jsonwebtoken)
- **2FA**: Speakeasy (TOTP generation)

### Security
- Cryptographic signing (crypto module)
- Secure cookie handling
- CORS configuration
- Rate limiting via transaction locks

## Installation

### Prerequisites
- Node.js (v14 or higher)
- MongoDB instance
- Steam account with API access
- NOWPayments account with API credentials

### Setup Steps

1. Clone the repository:
```bash
git clone <repository-url>
cd Crypto-bot
```

2. Install dependencies:
```bash
npm install
```

3. Configure the application:
Create a `config.js` file in the root directory (or `.config/config.js`):

```javascript
module.exports = {
    testMode: false,

    account: {
        accountName: "your_steam_username",
        password: "your_steam_password",
        sharedSecret: "your_shared_secret",
        identitySecret: "your_identity_secret"
    },

    db: {
        uri: "mongodb://localhost:27017",
        dbName: "crypto_trading_bot"
    },

    http: {
        domain: "yourdomain.com",
        port: 3000,
        ssl: false,
        jwt_secret: "your_secure_jwt_secret_min_32_chars",
        // For SSL:
        // key: "/path/to/private.key",
        // cert: "/path/to/certificate.crt"
    },

    payments: {
        nowPayments: {
            api: "your_nowpayments_api_key",
            email: "your_nowpayments_email",
            password: "your_nowpayments_password",
            ipn: "your_ipn_secret",
            ipn_callback: "payment_callback",
            otp_secret: "your_2fa_secret"
        }
    },

    discord: {
        webhook_url: "discord_webhook_for_notifications",
        webhook_errors_url: "discord_webhook_for_errors",
        webhook_chat_url: "discord_webhook_for_chat_logs"
    },

    admin: {
        profiles: ["steam_id_64_of_admin"]
    },

    classid: "101785959", // TF2 Mann Co. Supply Crate Key

    price: {
        buy: 1.66,
        sell: 1.5,
        max: 100,
        fee: 0.7,
        minimum_order: 10
    },

    messages: {
        pending: "You already have a pending transaction.",
        contact: "Contact us at: your_contact_info",
        withdrawal_cancel: "Withdrawals cannot be canceled.",
        confirm_cancel_deposit: "Type '!cancel confirm' to cancel."
    },

    max_retry_attempts: 5
};
```

4. Start the application:
```bash
node app.js
```

## API Endpoints

### Authentication
- `GET /steam_login` - Steam OpenID callback
- `GET /logout` - Invalidate session

### User Operations
- `GET /profile` - Retrieve user profile and balance
- `GET /history` - Fetch transaction history
- `GET /set_tradelink?tradelink=<url>` - Set Steam trade link

### Trading
- `GET /buy?amount=<number>` - Purchase keys
- `GET /sell?amount=<number>` - Sell keys
- `GET /prices` - Get current pricing information

### Payments
- `GET /deposit?amount=<number>` - Create deposit invoice
- `GET /withdraw?address=<addr>&currency=<code>&amount=<number>` - Initiate withdrawal
- `POST /<ipn_callback>` - Payment webhook (NOWPayments IPN)

### Utilities
- `GET /estimator?currency=<code>` - Get currency conversion estimate
- `WS /` - WebSocket connection for real-time updates

## Steam Chat Commands

### User Commands
- `!help` - Display available commands
- `!balance` - Check account balance
- `!buy <amount>` - Purchase keys
- `!sell <amount>` - Sell keys
- `!deposit <amount>` - Generate deposit invoice
- `!withdraw <address> <currency> [amount]` - Request withdrawal
- `!prices` - View current rates
- `!currencies` - List supported cryptocurrencies
- `!cancel` - Cancel pending transaction

### Admin Commands
- `!set_buy <price>` - Set purchase price per key
- `!set_sell <price>` - Set selling price per key
- `!fee <percentage>` - Configure transaction fee
- `!cap <number>` - Set maximum key stock
- `!min <amount>` - Set minimum order value
- `!set_balance <steam_id> <amount>` - Set user balance
- `!add_balance <steam_id> <amount>` - Adjust user balance
- `!ban <steam_id>` - Ban user
- `!unban <steam_id>` - Unban user
- `!restart [force]` - Restart bot

## Database Schema

### Collections

#### users
```javascript
{
    _id: ObjectId,
    steamID: String,
    balance: Number,
    tradelink: String (optional)
}
```

#### transactions
```javascript
{
    _id: ObjectId,
    steamID: String,
    type: String, // "buy", "sell", "deposit", "withdrawal", "purchase_deposit"
    amount: Number,
    difference: Number,
    status: String, // "pending", "finished", "failed"
    timestamp: Date,
    offer_id: String (optional),
    paid_via_crypto: Boolean (optional),
    batch_withdrawal_id: String (optional),
    currency: String (optional),
    address: String (optional)
}
```

## Performance Considerations

- **uWebSockets.js**: Provides superior performance compared to standard Express.js
- **Connection pooling**: MongoDB native driver with connection reuse
- **Caching**: Profile data cached for 10 minutes
- **Key reservation**: In-memory Set for O(1) lookup
- **WebSocket pub/sub**: Efficient real-time updates without polling

## Error Handling

- Retry logic for Steam API failures (up to 5 attempts)
- Transaction rollback on payment failures
- Automatic refunds for failed withdrawals
- Comprehensive logging via Discord webhooks
- Graceful degradation for external service outages

## Security Best Practices

1. Never commit `config.js` to version control
2. Use environment variables for sensitive data in production
3. Enable SSL/TLS for production deployments
4. Regularly rotate API keys and secrets
5. Implement rate limiting for public endpoints
6. Monitor Discord webhooks for suspicious activity
7. Keep dependencies updated

## Monitoring and Logging

The application provides comprehensive logging through Discord webhooks:
- **Notifications**: Successful operations, user registrations
- **Errors**: Failed API calls, transaction errors, exceptions
- **Chat Logs**: User interactions and command execution

## Scalability

Current architecture supports:
- Horizontal scaling through stateless design
- MongoDB replication for high availability
- WebSocket connections managed by uWebSockets.js
- Transaction locking prevents race conditions

## Known Limitations

- Single Steam account per instance
- NOWPayments withdrawal verification requires manual 2FA
- Transaction history grows unbounded (consider archival strategy)
- No automatic market price adjustment

## Development Roadmap

Potential enhancements:
- Multi-account support for higher volume
- Automatic price adjustment based on market rates
- Admin web dashboard
- Historical analytics and reporting
- Support for additional Steam games
- Automated backup system

## Contributing

This codebase demonstrates proficiency in:
- Asynchronous JavaScript programming
- RESTful API design
- WebSocket real-time communication
- Third-party API integration
- Database operations and transactions
- Authentication and authorization
- Error handling and logging
- System architecture design

## License

Please refer to the project's license file for usage terms.

## Support

For issues or questions regarding this project, please open an issue in the repository.

---

**Note**: This is an automated trading platform handling real financial transactions. Ensure compliance with local regulations regarding cryptocurrency trading and payment processing.
