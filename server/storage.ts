import { type InvitationLog, type InsertInvitationLog, type SystemStats, type InsertSystemStats, invitationLogs, systemStats } from "@shared/schema";
import { randomUUID } from "crypto";
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { eq, desc } from "drizzle-orm";

export interface IStorage {
  // Invitation logs
  getInvitationLog(conversationId: string): Promise<InvitationLog | undefined>;
  createInvitationLog(log: InsertInvitationLog): Promise<InvitationLog>;
  updateInvitationLog(conversationId: string, updates: Partial<InvitationLog>): Promise<InvitationLog | undefined>;
  getAllInvitationLogs(limit?: number, offset?: number): Promise<InvitationLog[]>;
  
  // System stats
  getSystemStats(): Promise<SystemStats | undefined>;
  updateSystemStats(stats: Partial<InsertSystemStats>): Promise<SystemStats>;
  incrementInviteCount(status: 'success' | 'failed'): Promise<void>;
}

export class MemStorage implements IStorage {
  private invitationLogs: Map<string, InvitationLog>;
  private systemStats: SystemStats;

  constructor() {
    this.invitationLogs = new Map();
    this.systemStats = {
      id: randomUUID(),
      totalInvites: 0,
      successfulInvites: 0,
      failedInvites: 0,
      lastUpdated: new Date(),
    };
  }

  async getInvitationLog(conversationId: string): Promise<InvitationLog | undefined> {
    return this.invitationLogs.get(conversationId);
  }

  async createInvitationLog(insertLog: InsertInvitationLog): Promise<InvitationLog> {
    const log: InvitationLog = {
      id: randomUUID(),
      ...insertLog,
      retryCount: insertLog.retryCount ?? 0,
      errorMessage: insertLog.errorMessage ?? null,
      trustpilotInvitationId: insertLog.trustpilotInvitationId ?? null,
      responseLog: insertLog.responseLog ?? null,
      timestamp: new Date(),
    };
    this.invitationLogs.set(log.conversationId, log);
    return log;
  }

  async updateInvitationLog(conversationId: string, updates: Partial<InvitationLog>): Promise<InvitationLog | undefined> {
    const existing = this.invitationLogs.get(conversationId);
    if (!existing) return undefined;

    const updated = { ...existing, ...updates };
    this.invitationLogs.set(conversationId, updated);
    return updated;
  }

  async getAllInvitationLogs(limit = 50, offset = 0): Promise<InvitationLog[]> {
    const logs = Array.from(this.invitationLogs.values())
      .sort((a, b) => (b.timestamp?.getTime() || 0) - (a.timestamp?.getTime() || 0))
      .slice(offset, offset + limit);
    return logs;
  }

  async getSystemStats(): Promise<SystemStats | undefined> {
    return this.systemStats;
  }

  async updateSystemStats(stats: Partial<InsertSystemStats>): Promise<SystemStats> {
    this.systemStats = {
      ...this.systemStats,
      ...stats,
      lastUpdated: new Date(),
    };
    return this.systemStats;
  }

  async incrementInviteCount(status: 'success' | 'failed'): Promise<void> {
    this.systemStats.totalInvites = (this.systemStats.totalInvites || 0) + 1;
    if (status === 'success') {
      this.systemStats.successfulInvites = (this.systemStats.successfulInvites || 0) + 1;
    } else {
      this.systemStats.failedInvites = (this.systemStats.failedInvites || 0) + 1;
    }
    this.systemStats.lastUpdated = new Date();
  }
}

export class DbStorage implements IStorage {
  private db;

  constructor() {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      throw new Error("DATABASE_URL environment variable is not set");
    }
    
    const sql = neon(databaseUrl);
    this.db = drizzle(sql);
  }

  async getInvitationLog(conversationId: string): Promise<InvitationLog | undefined> {
    const result = await this.db
      .select()
      .from(invitationLogs)
      .where(eq(invitationLogs.conversationId, conversationId))
      .limit(1);
    
    return result[0];
  }

  async createInvitationLog(insertLog: InsertInvitationLog): Promise<InvitationLog> {
    const result = await this.db
      .insert(invitationLogs)
      .values(insertLog)
      .returning();
    
    return result[0];
  }

  async updateInvitationLog(conversationId: string, updates: Partial<InvitationLog>): Promise<InvitationLog | undefined> {
    const result = await this.db
      .update(invitationLogs)
      .set(updates)
      .where(eq(invitationLogs.conversationId, conversationId))
      .returning();
    
    return result[0];
  }

  async getAllInvitationLogs(limit = 50, offset = 0): Promise<InvitationLog[]> {
    const logs = await this.db
      .select()
      .from(invitationLogs)
      .orderBy(desc(invitationLogs.timestamp))
      .limit(limit)
      .offset(offset);
    
    return logs;
  }

  async getSystemStats(): Promise<SystemStats | undefined> {
    const result = await this.db
      .select()
      .from(systemStats)
      .limit(1);
    
    if (result.length === 0) {
      const newStats = await this.db
        .insert(systemStats)
        .values({
          totalInvites: 0,
          successfulInvites: 0,
          failedInvites: 0,
        })
        .returning();
      
      return newStats[0];
    }
    
    return result[0];
  }

  async updateSystemStats(stats: Partial<InsertSystemStats>): Promise<SystemStats> {
    const existing = await this.getSystemStats();
    
    if (!existing) {
      const newStats = await this.db
        .insert(systemStats)
        .values({
          totalInvites: stats.totalInvites || 0,
          successfulInvites: stats.successfulInvites || 0,
          failedInvites: stats.failedInvites || 0,
        })
        .returning();
      
      return newStats[0];
    }
    
    const result = await this.db
      .update(systemStats)
      .set({
        ...stats,
        lastUpdated: new Date(),
      })
      .where(eq(systemStats.id, existing.id))
      .returning();
    
    return result[0];
  }

  async incrementInviteCount(status: 'success' | 'failed'): Promise<void> {
    const stats = await this.getSystemStats();
    
    if (!stats) {
      return;
    }
    
    await this.db
      .update(systemStats)
      .set({
        totalInvites: (stats.totalInvites || 0) + 1,
        successfulInvites: status === 'success' ? (stats.successfulInvites || 0) + 1 : stats.successfulInvites,
        failedInvites: status === 'failed' ? (stats.failedInvites || 0) + 1 : stats.failedInvites,
        lastUpdated: new Date(),
      })
      .where(eq(systemStats.id, stats.id));
  }
}

export const storage = new DbStorage();
