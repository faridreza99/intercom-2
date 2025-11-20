# Overview

This is an automation service that connects Intercom to Trustpilot, automatically sending review invitations when Intercom conversations close. The system consists of a Node.js backend with Express that handles webhooks and API integrations, paired with a React frontend dashboard for monitoring and management. The service features robust error handling, retry logic, comprehensive logging, and real-time monitoring capabilities.

# User Preferences

Preferred communication style: Simple, everyday language.

# System Architecture

## Frontend Architecture
- **Framework**: React 18 with TypeScript, built using Vite
- **UI Library**: Shadcn/ui components with Radix UI primitives and Tailwind CSS
- **Routing**: Wouter for lightweight client-side routing
- **State Management**: TanStack Query for server state and API calls
- **Styling**: Tailwind CSS with custom design system variables

## Backend Architecture
- **Framework**: Express.js with TypeScript running on Node.js
- **API Design**: RESTful endpoints for webhook handling, system monitoring, and configuration
- **Webhook Processing**: Handles Intercom conversation closure events with idempotency
- **Retry Logic**: Exponential backoff pattern (5s, 10s, 20s delays) for failed API calls
- **Storage Layer**: PostgreSQL database storage using Drizzle ORM for persistent data storage
- **Service Layer**: Modular service architecture for Trustpilot API integration and logging

## Data Storage
- **Database**: PostgreSQL with Drizzle ORM configured (using Neon serverless)
- **Schema**: Tracks invitation logs, system statistics, and operational metrics
- **Logging**: File-based JSON logging system for invitation tracking and debugging
- **Session Management**: PostgreSQL session store with connect-pg-simple

## Integration Architecture
- **Intercom Integration**: Webhook receiver for conversation closure events
- **Trustpilot Integration**: OAuth-based API client for sending review invitations
- **Error Handling**: Comprehensive retry logic with status tracking and failure logging
- **Idempotency**: Prevents duplicate invitations using conversation ID tracking

## Monitoring and Operations
- **Health Checks**: System health monitoring for all external services
- **Real-time Dashboard**: Live updates of invitation statistics and system status
- **Configuration Management**: Environment-based configuration with admin panel
- **Logging**: Structured JSON logging with file persistence and rotation

# External Dependencies

## Third-Party Services
- **Intercom**: Customer messaging platform providing webhook events for conversation closures
- **Trustpilot**: Review platform API for sending automated review invitations
- **Neon Database**: Serverless PostgreSQL hosting for production data storage

## Key Libraries and Frameworks
- **Express.js**: Web server framework for API endpoints and middleware
- **React**: Frontend UI library with TypeScript support
- **Drizzle ORM**: Type-safe database ORM with PostgreSQL support
- **TanStack Query**: Server state management and caching for React
- **Shadcn/ui**: Component library built on Radix UI primitives
- **Tailwind CSS**: Utility-first CSS framework for styling
- **Zod**: Schema validation for API requests and data structures
- **Axios**: HTTP client for external API integrations

## Development Tools
- **Vite**: Build tool and development server with hot module replacement
- **TypeScript**: Type safety across the entire application
- **ESBuild**: Fast JavaScript bundler for production builds
- **Wouter**: Minimalist routing library for React applications