export interface IntercomConfig {
  token: string;
}

export class IntercomService {
  private config: IntercomConfig;
  private baseUrl = 'https://api.intercom.io';

  constructor(config: IntercomConfig) {
    this.config = config;
  }

  async testConnection(): Promise<boolean> {
    try {
      console.log('Testing Intercom connection...');
      console.log('Token length:', this.config.token.length);
      console.log('Token starts with:', this.config.token.substring(0, 10) + '...');
      
      // Test the connection by fetching the current user/admin info
      // Intercom uses Bearer Token authentication
      const response = await fetch(`${this.baseUrl}/me`, {
        headers: {
          'Authorization': `Bearer ${this.config.token}`,
          'Accept': 'application/json',
          'Content-Type': 'application/json',
        },
      });

      console.log('Intercom API response status:', response.status);
      console.log('Intercom API response headers:', Object.fromEntries(response.headers.entries()));
      
      if (!response.ok) {
        const errorText = await response.text();
        console.log('Intercom API error response:', errorText);
      }

      return response.ok;
    } catch (error) {
      console.error('Intercom connection test failed:', error);
      return false;
    }
  }

  async unarchiveContact(contactId: string): Promise<boolean> {
    try {
      console.log(`Unarchiving contact: ${contactId}`);
      
      const response = await fetch(`${this.baseUrl}/contacts/${contactId}/unarchive`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.config.token}`,
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          'Intercom-Version': '2.11',
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`Failed to unarchive contact ${contactId}:`, errorText);
        return false;
      }

      console.log(`Successfully unarchived contact: ${contactId}`);
      return true;
    } catch (error) {
      console.error(`Error unarchiving contact ${contactId}:`, error);
      return false;
    }
  }

  async getContact(contactId: string): Promise<{ email: string; name: string } | null> {
    try {
      console.log(`Fetching contact details: ${contactId}`);
      
      const response = await fetch(`${this.baseUrl}/contacts/${contactId}`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${this.config.token}`,
          'Accept': 'application/json',
          'Intercom-Version': '2.11',
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`Failed to fetch contact ${contactId}:`, errorText);
        return null;
      }

      const contactData = await response.json();
      
      const email = contactData.email || '';
      const name = contactData.name || contactData.custom_attributes?.name || 'Valued Customer';

      console.log(`Contact details retrieved - Email: ${email ? '✓' : '✗'}, Name: ${name}`);

      return { email, name };
    } catch (error) {
      console.error(`Error fetching contact ${contactId}:`, error);
      return null;
    }
  }
}

export function createIntercomService(): IntercomService {
  const token = process.env.INTERCOM_TOKEN || '';
  
  // Intercom uses Bearer Token authentication - use the token directly
  console.log('Using Intercom token for Bearer authentication');

  const config: IntercomConfig = {
    token: token,
  };

  if (!config.token) {
    throw new Error('Missing required Intercom environment variables');
  }

  return new IntercomService(config);
}