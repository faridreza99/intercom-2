# Intercom-Trustpilot Automation Service

A production-ready Node.js automation service that connects Intercom to Trustpilot, automatically sending review invitations when conversations close.

## 🚀 Features

- **Webhook Integration**: Receives Intercom conversation closure events
- **Automated Review Invitations**: Sends Trustpilot review invitations automatically
- **Retry Logic**: Exponential backoff retry mechanism (5s, 10s, 20s delays)
- **Idempotency**: Prevents duplicate invitations for the same conversation
- **Admin Dashboard**: Real-time monitoring and management interface
- **Comprehensive Logging**: File-based logging with JSON structure
- **Health Monitoring**: System health checks and API status monitoring

## 📋 Prerequisites

- Node.js 18+ 
- Intercom account with API access
- Trustpilot Business account with API access

## 🔧 Installation

1. **Clone the repository:**
   ```bash
   git clone <repository-url>
   cd intercom-trustpilot-automation
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Set up environment variables:**
   ```bash
   cp .env.example .env
   ```

4. **Configure your API credentials in `.env`:**
   ```bash
   INTERCOM_TOKEN=your_intercom_access_token
   INTERCOM_CLIENT_ID=your_intercom_client_id
   INTERCOM_CLIENT_SECRET=your_intercom_client_secret
   TRUSTPILOT_API_KEY=your_trustpilot_api_key
   TRUSTPILOT_SECRET_KEY=your_trustpilot_secret_key
   TRUSTPILOT_BUSINESS_UNIT_ID=your_business_unit_id
   TEMPLATE_ID=your_trustpilot_template_id
   