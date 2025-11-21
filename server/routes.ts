import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { logger } from "./services/logger";
import { createTrustpilotService } from "./services/trustpilot";
import { createIntercomService } from "./services/intercom";
import { createEmailService, type ReviewInvitationData } from "./services/email";
import { intercomWebhookSchema } from "@shared/schema";
import { z } from "zod";
import { log } from "./vite";
import bodyParser from "body-parser";

// Retry configuration
const RETRY_DELAYS = [5000, 10000, 20000]; // 5s, 10s, 20s
const MAX_RETRIES = 3;

async function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function processInvitationWithRetry(
  conversationId: string,
  email: string,
  name: string,
  agentName: string,
  retryCount = 0
): Promise<void> {
  try {
    const emailService = createEmailService();
    
    // Generate Trustpilot review link
    const businessName = process.env.BUSINESS_NAME || 'Our Business';
    const trustpilotDomain = process.env.TRUSTPILOT_DOMAIN || 'your-business.trustpilot.com';
    const reviewLink = `https://www.trustpilot.com/evaluate/${trustpilotDomain}?utm_source=email&utm_medium=invitation&utm_campaign=intercom_automation`;
    
    const reviewData: ReviewInvitationData = {
      customerEmail: email,
      customerName: name,
      agentName,
      conversationId,
      businessName,
      reviewLink,
    };

    const result = await emailService.sendReviewInvitation(reviewData);

    if (result.success) {
      // Update log with success
      await storage.updateInvitationLog(conversationId, {
        status: 'success',
        responseLog: JSON.stringify(result),
      });

      await storage.incrementInviteCount('success');

      const updatedLog = await storage.getInvitationLog(conversationId);
      if (updatedLog) {
        await logger.logInvitation(updatedLog);
      }

      console.log(`Successfully sent invitation for conversation ${conversationId}`);
    } else {
      throw new Error(result.error || 'Failed to send invitation');
    }
  } catch (error: any) {
    console.error(`Error sending invitation for conversation ${conversationId}:`, error);

    if (retryCount < MAX_RETRIES) {
      // Update retry count and schedule retry
      await storage.updateInvitationLog(conversationId, {
        status: 'retrying',
        retryCount: retryCount + 1,
        errorMessage: error.message,
      });

      // Schedule retry
      const delayMs = RETRY_DELAYS[retryCount];
      console.log(`Retrying in ${delayMs}ms...`);
      
      setTimeout(() => {
        processInvitationWithRetry(conversationId, email, name, agentName, retryCount + 1);
      }, delayMs);
    } else {
      // Max retries reached - mark as failed
      await storage.updateInvitationLog(conversationId, {
        status: 'failed',
        errorMessage: error.message,
      });

      await storage.incrementInviteCount('failed');

      const log = await storage.getInvitationLog(conversationId);
      if (log) {
        await logger.logInvitation(log);
      }

      console.error(`Failed to send invitation for conversation ${conversationId} after ${MAX_RETRIES} attempts`);
    }
  }
}

export async function registerRoutes(app: Express): Promise<Server> {
  // Remove the early guard middleware since Express routes POST to the specific handler

  // CRITICAL: Apply raw body parser BEFORE any other middleware for webhook routes
  // Use tolerant content-type matching to handle charset variations
  app.use('/api/webhook/intercom', bodyParser.raw({ type: () => true }));
  app.use('/api/notifications/intercom', bodyParser.raw({ type: () => true }));

  // CRITICAL: Handle OPTIONS for webhook endpoint FIRST (before any other routes)
  app.options("/api/webhook/intercom", (req, res) => {
    res.header('Access-Control-Allow-Origin', req.get('Origin') || '*');
    res.header('Access-Control-Allow-Methods', 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-Intercom-Webhook-Secret,X-Requested-With,Origin,Accept');
    res.header('Access-Control-Max-Age', '86400');
    res.status(204).end();
  });

  // Priority middleware: Handle ALL /api routes before Vite intercepts them
  app.use('/api', (req, res, next) => {
    // Set CORS headers for all API requests
    res.header('Access-Control-Allow-Origin', req.get('Origin') || '*');
    res.header('Access-Control-Allow-Methods', 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-Intercom-Webhook-Secret,X-Requested-With,Origin,Accept');
    
    // If it's an OPTIONS request, end here
    if (req.method === 'OPTIONS') {
      return res.status(204).end();
    }
    next();
  });

  // Webhook verification endpoint for Intercom
  app.get("/api/webhook/intercom", async (req, res) => {
    // Handle Intercom webhook verification challenge
    const challenge = req.query['hub.challenge'];
    if (challenge) {
      log('Intercom webhook verification challenge received: ' + challenge);
      res.status(200).send(challenge);
      return;
    }
    res.status(200).send('Webhook endpoint is active');
  });

  // ROBUST WEBHOOK: Production-ready endpoint with full webhook processing
  app.post("/api/notifications/intercom", async (req, res) => {
    log(`🔔 INTERCOM NOTIFICATIONS POST ${req.originalUrl}`);
    
    try {
      // Parse webhook payload - req.body is a Buffer due to raw body parser
      let webhookData;
      if (Buffer.isBuffer(req.body)) {
        const bodyString = req.body.toString('utf-8');
        log(`📦 Raw body (first 200 chars): ${bodyString.substring(0, 200)}`);
        webhookData = bodyString ? JSON.parse(bodyString) : null;
      } else {
        webhookData = req.body;
      }
      
      log(`📋 Parsed webhook data type: ${webhookData?.type || 'undefined'}`);
      
      // Handle verification requests first (empty or test payloads)
      if (!webhookData || !webhookData.type) {
        log('Webhook verification request - returning success');
        return res.status(200).json({
          message: 'Webhook endpoint is ready and active',
          status: 'ok',
          timestamp: new Date().toISOString()
        });
      }

      // Validate the webhook data structure
      const validatedData = intercomWebhookSchema.parse(webhookData);
      log(`Webhook event: ${validatedData.topic}`);

      // Only process conversation.closed events
      if (validatedData.topic === 'conversation.admin.closed' || validatedData.topic === 'conversation.closed') {
        const conversation = validatedData.data.item;
        
        if (!conversation) {
          log(`⚠️ No conversation data in webhook payload`);
          return res.status(200).json({ message: 'No conversation data found' });
        }
        
        const conversationId = conversation.id;

        // Check for deduplication
        const existingLog = await storage.getInvitationLog(conversationId);
        if (existingLog) {
          log(`Duplicate webhook for conversation ${conversationId} - skipping`);
          return res.status(200).json({ 
            message: 'Webhook processed (duplicate)', 
            conversationId,
            timestamp: new Date().toISOString()
          });
        }

        // Extract customer contact ID from webhook payload
        const contacts = conversation.contacts?.contacts || [];
        if (contacts.length === 0) {
          log(`No contacts found in conversation ${conversationId}`);
          return res.status(200).json({ message: 'No contacts to process' });
        }

        const contactId = contacts[0].id;
        if (!contactId) {
          log(`No contact ID found for conversation ${conversationId}`);
          return res.status(200).json({ message: 'No contact ID found' });
        }

        // Unarchive contact and fetch details via Intercom API
        log(`Fetching contact details for contact ID: ${contactId}`);
        const intercomService = createIntercomService();
        
        // Step 1: Unarchive the contact (required for archived contacts to return PII)
        await intercomService.unarchiveContact(contactId);
        
        // Step 2: Fetch contact details from Intercom API
        const contactDetails = await intercomService.getContact(contactId);
        
        if (!contactDetails || !contactDetails.email) {
          log(`Failed to retrieve contact details for conversation ${conversationId}`);
          return res.status(200).json({ message: 'Failed to retrieve contact email' });
        }

        const email = contactDetails.email;
        const name = contactDetails.name || 'Valued Customer';

        // Get the closing agent
        const parts = conversation.conversation_parts?.conversation_parts || [];
        const lastPart = parts[parts.length - 1];
        const agentName = lastPart?.author?.name || 'Our Support Team';

        // Store initial log
        await storage.createInvitationLog({
          conversationId,
          customerEmail: email,
          customerName: name,
          agentName,
          status: 'processing',
        });

        // Process invitation asynchronously 
        processInvitationWithRetry(conversationId, email, name, agentName)
          .catch(error => {
            console.error(`Async invitation processing failed for ${conversationId}:`, error);
          });

        log(`Started processing invitation for ${email} (conversation: ${conversationId})`);
        
        return res.status(200).json({ 
          message: 'Webhook processed successfully', 
          conversationId,
          customerEmail: email,
          timestamp: new Date().toISOString()
        });
      } else {
        log(`ℹ️ Ignored webhook topic: ${validatedData.topic}`);
        return res.status(200).json({ 
          message: 'Webhook received but not processed', 
          topic: validatedData.topic,
          timestamp: new Date().toISOString() 
        });
      }

    } catch (error: any) {
      console.error('Error processing webhook:', error);
      log(`Webhook processing error: ${error.message}`);
      
      // Still return 200 to prevent Intercom from retrying
      return res.status(200).json({ 
        message: 'Webhook received but processing failed', 
        error: error.message,
        timestamp: new Date().toISOString()
      });
    }
  });

  // PRIMARY WEBHOOK ENDPOINT - Full processing with archived contact handling
  app.post("/api/webhook/intercom", async (req, res) => {
    log(`🔔 WEBHOOK POST ${req.originalUrl}`);
    
    try {
      // Parse webhook payload - req.body is a Buffer due to raw body parser
      let webhookData;
      if (Buffer.isBuffer(req.body)) {
        const bodyString = req.body.toString('utf-8');
        log(`📦 Raw body (first 500 chars): ${bodyString.substring(0, 500)}`);
        webhookData = bodyString ? JSON.parse(bodyString) : null;
      } else {
        log(`📦 Body is not Buffer, type: ${typeof req.body}`);
        webhookData = req.body;
      }
      
      log(`📋 Parsed webhook data type: ${webhookData?.type || 'undefined'}`);
      log(`📊 Full webhook payload keys: ${webhookData ? Object.keys(webhookData).join(', ') : 'null'}`);
      if (webhookData?.data?.item) {
        log(`📊 Conversation item keys: ${Object.keys(webhookData.data.item).join(', ')}`);
      }
      
      // Handle verification requests first (empty or test payloads)
      if (!webhookData || !webhookData.type) {
        log(`⚠️ EMPTY WEBHOOK PAYLOAD - No type field found. Payload: ${JSON.stringify(webhookData).substring(0, 500)}`);
        return res.status(200).json({
          message: 'Webhook endpoint is ready and active',
          status: 'ok',
          timestamp: new Date().toISOString()
        });
      }

      // Validate the webhook data structure (use safeParse to handle validation errors gracefully)
      const validationResult = intercomWebhookSchema.safeParse(webhookData);
      
      if (!validationResult.success) {
        log(`⚠️ Webhook schema validation failed, but continuing with raw data...`);
        log(`⚠️ Validation errors: ${JSON.stringify(validationResult.error.errors).substring(0, 300)}`);
      }
      
      const eventTopic = webhookData.topic || webhookData.type;
      log(`✅ Webhook event received: ${eventTopic}`);

      // Only process conversation.closed events (use raw webhookData since validation may have failed)
      if (eventTopic === 'conversation.admin.closed' || eventTopic === 'conversation.closed') {
        const conversation = webhookData.data.item;
        const conversationId = conversation.id;
        log(`📋 Processing conversation: ${conversationId}`);

        // Check for deduplication
        const existingLog = await storage.getInvitationLog(conversationId);
        if (existingLog) {
          log(`⚠️ Duplicate webhook for conversation ${conversationId} - skipping`);
          return res.status(200).json({ 
            message: 'Webhook processed (duplicate)', 
            conversationId,
            timestamp: new Date().toISOString()
          });
        }

        // Extract customer contact ID from webhook payload
        const contacts = conversation.contacts?.contacts || [];
        log(`📇 Found ${contacts.length} contact(s) in conversation ${conversationId}`);
        
        if (contacts.length === 0) {
          log(`⚠️ No contacts array found in conversation ${conversationId}`);
          log(`📊 Conversation object keys: ${Object.keys(conversation).join(', ')}`);
          return res.status(200).json({ message: 'No contacts to process' });
        }

        const contactId = contacts[0].id;
        log(`📇 Extracted contact ID from payload: ${contactId || 'null/undefined'}`);
        
        if (!contactId) {
          log(`⚠️ No contact ID found in first contact object for conversation ${conversationId}`);
          log(`📊 First contact object keys: ${Object.keys(contacts[0]).join(', ')}`);
          return res.status(200).json({ message: 'No contact ID found' });
        }

        // ══════════════════════════════════════════════════════════════
        // INTERCOM ARCHIVED CONTACT FIX (per Erik's guidance)
        // Step 1: Unarchive contact to restore PII access
        // Step 2: Fetch contact details via API to get email/name
        // ══════════════════════════════════════════════════════════════
        log(`🔍 Processing contact ID: ${contactId} for conversation: ${conversationId}`);
        const intercomService = createIntercomService();
        
        // Step 1: Unarchive the contact (required for archived contacts to return PII)
        log(`📤 Step 1: Calling unarchiveContact(${contactId})...`);
        const unarchiveResult = await intercomService.unarchiveContact(contactId);
        log(`📤 Unarchive result: ${unarchiveResult ? 'SUCCESS' : 'FAILED'}`);
        
        // Step 2: Fetch contact details from Intercom API
        log(`📥 Step 2: Calling getContact(${contactId})...`);
        const contactDetails = await intercomService.getContact(contactId);
        log(`📥 GetContact result: ${contactDetails ? 'SUCCESS' : 'NULL'}`);
        
        if (!contactDetails) {
          log(`❌ getContact returned NULL for contact ${contactId} in conversation ${conversationId}`);
          return res.status(200).json({ 
            message: 'Failed to retrieve contact details - API returned null',
            conversationId,
            contactId,
            timestamp: new Date().toISOString()
          });
        }
        
        if (!contactDetails.email) {
          log(`❌ Contact details retrieved but NO EMAIL found for contact ${contactId}`);
          log(`📊 Contact details keys: ${Object.keys(contactDetails).join(', ')}`);
          return res.status(200).json({ 
            message: 'Failed to retrieve contact email - email field is empty',
            conversationId,
            contactId,
            timestamp: new Date().toISOString()
          });
        }

        const email = contactDetails.email;
        const name = contactDetails.name || 'Valued Customer';
        log(`✅ Contact details retrieved - Email: ${email}, Name: ${name}, Contact ID: ${contactId}`);

        // Get the closing agent
        const parts = conversation.conversation_parts?.conversation_parts || [];
        const lastPart = parts[parts.length - 1];
        const agentName = lastPart?.author?.name || 'Our Support Team';

        // Store initial log
        await storage.createInvitationLog({
          conversationId,
          customerEmail: email,
          customerName: name,
          agentName,
          status: 'processing',
        });

        // Process invitation asynchronously 
        processInvitationWithRetry(conversationId, email, name, agentName)
          .catch(error => {
            console.error(`Async invitation processing failed for ${conversationId}:`, error);
          });

        log(`✅ Started processing invitation for ${email} (conversation: ${conversationId})`);
        
        return res.status(200).json({ 
          message: 'Webhook processed successfully', 
          conversationId,
          customerEmail: email,
          customerName: name,
          status: 'ok',
          timestamp: new Date().toISOString()
        });
      } else {
        log(`ℹ️ Ignored webhook topic: ${eventTopic}`);
        return res.status(200).json({ 
          message: 'Webhook received but not processed', 
          topic: eventTopic,
          timestamp: new Date().toISOString() 
        });
      }

    } catch (error: any) {
      console.error('❌ Error processing webhook:', error);
      log(`❌ Webhook processing error: ${error.message}`);
      
      // Still return 200 to prevent Intercom from retrying
      return res.status(200).json({ 
        message: 'Webhook received but processing failed', 
        error: error.message,
        timestamp: new Date().toISOString()
      });
    }
  });

  // Get logs endpoint
  app.get("/api/logs", async (req, res) => {
    try {
      const limit = parseInt(req.query.limit as string) || 50;
      const offset = parseInt(req.query.offset as string) || 0;
      
      const logs = await storage.getAllInvitationLogs(limit, offset);
      res.json(logs);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  // Get system stats
  app.get("/api/stats", async (req, res) => {
    try {
      const stats = await storage.getSystemStats();
      res.json(stats);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  // Debug endpoint to verify deployment instance
  app.get("/api/debug/instance", async (req, res) => {
    const { intercomWebhookSchema } = await import("@shared/schema");
    const acceptedEvents = (intercomWebhookSchema.shape.topic as any)._def?.values || ['conversation.closed'];
    
    res.json({
      message: "Instance debug info",
      startedAt: new Date().toISOString(),
      nodeVersion: process.version,
      acceptedWebhookEvents: acceptedEvents,
      environment: process.env.NODE_ENV,
      instanceId: Math.random().toString(36).substring(7)
    });
  });

  // Test webhook endpoint
  app.post("/api/test/webhook", async (req, res) => {
    try {
      const testPayload = {
        type: "notification_event",
        topic: "conversation.closed",
        data: {
          item: {
            id: `test_${Date.now()}`,
            contacts: {
              contacts: [{
                id: "test_contact_123",
                email: "test@example.com",
                name: "Test Customer"
              }]
            },
            conversation_parts: {
              conversation_parts: [{
                author: {
                  name: "Test Agent",
                  type: "admin"
                }
              }]
            }
          }
        }
      };

      // Send to our own webhook endpoint
      const response = await fetch(`${req.protocol}://${req.get('host')}/api/webhook/intercom`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(testPayload),
      });

      if (response.ok) {
        res.json({ message: "Test webhook sent successfully" });
      } else {
        throw new Error(`Webhook test failed: ${response.statusText}`);
      }
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  // Health check endpoint
  app.get("/api/health", async (req, res) => {
    try {
      const intercomService = createIntercomService();
      const emailService = createEmailService();
      
      const healthChecks = [];
      
      // Test Intercom connection
      try {
        await intercomService.testConnection();
        healthChecks.push({ service: "intercom", status: "healthy" });
      } catch (error: any) {
        healthChecks.push({ service: "intercom", status: "unhealthy", error: error.message });
      }
      
      // Test email service
      try {
        await emailService.testConnection();
        healthChecks.push({ service: "email", status: "healthy" });
      } catch (error: any) {
        healthChecks.push({ service: "email", status: "unhealthy", error: error.message });
      }
      
      const allHealthy = healthChecks.every(check => check.status === "healthy");
      
      res.status(allHealthy ? 200 : 503).json({
        status: allHealthy ? "healthy" : "unhealthy",
        timestamp: new Date().toISOString(),
        services: healthChecks
      });
    } catch (error: any) {
      res.status(500).json({
        status: "error",
        timestamp: new Date().toISOString(),
        error: error.message
      });
    }
  });

  // Configuration endpoint
  app.get("/api/config", async (req, res) => {
    try {
      const intercomService = createIntercomService();
      
      // Test connections and return config status
      const config = {
        intercom: {
          hasToken: !!process.env.INTERCOM_TOKEN,
          tokenMasked: process.env.INTERCOM_TOKEN ? process.env.INTERCOM_TOKEN.substring(0, 8) + '••••••••' : '',
        },
        smtp: {
          hasUser: !!process.env.SMTP_USER,
          hasPassword: !!process.env.SMTP_PASS,
          host: process.env.SMTP_HOST || 'smtp.gmail.com',
          port: process.env.SMTP_PORT || '587',
          fromEmail: process.env.SMTP_FROM_EMAIL || '',
          fromName: process.env.SMTP_FROM_NAME || 'Customer Success Team',
          userMasked: process.env.SMTP_USER ? process.env.SMTP_USER.substring(0, 3) + '••••••••' : '',
        },
        business: {
          businessName: process.env.BUSINESS_NAME || 'Our Business',
          trustpilotDomain: process.env.TRUSTPILOT_DOMAIN || 'your-business.trustpilot.com',
        }
      };
      
      res.json(config);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  // PRODUCTION WEBHOOK: Working endpoint for Intercom webhooks
  app.post("/api/test/intercom", async (req, res) => {
    log(`🔔 PRODUCTION INTERCOM WEBHOOK ${req.originalUrl}`);
    
    try {
      // Parse webhook payload - Intercom sends JSON
      const webhookData = req.body;
      
      // Always return success for webhook verification/testing
      if (!webhookData || (!webhookData.type && !webhookData.topic)) {
        log('Webhook verification request - returning success');
        return res.status(200).json({
          message: 'Webhook endpoint is ready and active',
          status: 'ok',
          timestamp: new Date().toISOString()
        });
      }
      
      // Process conversation closure events (check topic field, fallback to type for backward compatibility)
      const eventTopic = webhookData.topic || webhookData.type;
      if (eventTopic === 'conversation.admin.closed' || eventTopic === 'conversation.closed') {
        log(`Processing conversation closure: ${webhookData.data?.item?.id}`);
        
        const conversationId = webhookData.data?.item?.id;
        const contacts = webhookData.data?.item?.contacts?.contacts || [];
        const conversationParts = webhookData.data?.item?.conversation_parts?.conversation_parts || [];
        
        // Find admin who closed the conversation
        const adminPart = conversationParts.find((part: any) => 
          part.author?.type === 'admin' && part.part_type === 'close'
        );
        const agentName = adminPart?.author?.name || 'Support Agent';
        
        // Process each contact
        for (const contact of contacts) {
          if (contact.email && contact.name) {
            try {
              await processInvitationWithRetry(
                conversationId,
                contact.email,
                contact.name,
                agentName
              );
              log(`Queued invitation for ${contact.email}`);
            } catch (error: any) {
              log(`Failed to queue invitation for ${contact.email}: ${error.message}`);
            }
          }
        }
        
        return res.status(200).json({
          message: 'Webhook processed successfully',
          status: 'ok',
          timestamp: new Date().toISOString(),
          conversationId,
          contactsProcessed: contacts.length
        });
      }
      
      // For other event types, just acknowledge
      log(`Received webhook: ${eventTopic} - acknowledged`);
      return res.status(200).json({
        message: 'Webhook received and acknowledged',
        status: 'ok',
        timestamp: new Date().toISOString(),
        eventType: eventTopic
      });
      
    } catch (error: any) {
      log(`Webhook processing error: ${error.message}`);
      
      // Always return 200 to prevent Intercom from retrying failed webhook tests
      return res.status(200).json({
        message: 'Webhook endpoint is active',
        status: 'ok',
        timestamp: new Date().toISOString(),
        note: 'Error logged for investigation'
      });
    }
  });

  const server = createServer(app);
  
  return server;
}