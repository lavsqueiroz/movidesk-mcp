/**
 * Movidesk API Client
 */

import axios, { AxiosInstance } from 'axios';

interface MovideskTicket {
  id: string;
  protocol?: string;
  subject?: string;
  status?: string;
  justificativa?: string;
  createdDate?: string;
  actions?: any[];
}

interface CreateNoteParams {
  ticketId: string;
  description: string;
  isInternal: boolean;
}

interface ListTicketsParams {
  limit?: number;
  status?: string;
}

interface ListByJustificativaParams {
  limit?: number;
  justificativas: string[];
}

export class MovideskClient {
  private httpClient: AxiosInstance;
  private token: string;

  constructor() {
    this.token = process.env.MOVIDESK_TOKEN || '';
    if (!this.token) throw new Error('MOVIDESK_TOKEN nao configurado');

    this.httpClient = axios.create({
      baseURL: 'https://api.movidesk.com/public/v1',
      timeout: 30000,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  async getStatusConfigs(): Promise<any[]> {
    try {
      console.error('Buscando status...');
      // Endpoint correto da API do Movidesk
      const response = await this.httpClient.get('/tickets/statusConfigs', {
        params: { token: this.token },
      });
      const statuses = Array.isArray(response.data) ? response.data : [response.data];
      console.error(`${statuses.length} status retornados`);
      return statuses;
    } catch (error: any) {
      console.error('Erro ao buscar status:', error.message);
      if (error.response) {
        console.error('HTTP Status:', error.response.status);
        console.error('Data:', JSON.stringify(error.response.data));
      }
      throw error;
    }
  }

  async listTickets(params: ListTicketsParams = {}): Promise<MovideskTicket[]> {
    try {
      const { limit = 50, status } = params;
      console.error(`Buscando tickets...`);

      // Busca todos e filtra localmente para evitar problemas com $filter na API
      const response = await this.httpClient.get('/tickets', {
        params: {
          token: this.token,
          $select: 'id,protocol,subject,status,createdDate',
          $top: 200,
        },
      });

      let tickets = Array.isArray(response.data) ? response.data : [response.data];

      // Filtra por status localmente se informado
      if (status) {
        tickets = tickets.filter((t: any) =>
          (t.status || '').toLowerCase() === status.toLowerCase()
        );
      }

      tickets = tickets.slice(0, limit);
      console.error(`${tickets.length} tickets retornados (status=${status})`);
      return tickets;
    } catch (error: any) {
      console.error('Erro ao listar tickets:', error.message);
      if (error.response) {
        console.error('HTTP Status:', error.response.status);
        console.error('Data:', JSON.stringify(error.response.data));
      }
      throw error;
    }
  }

  async listTicketsByJustificativas(params: ListByJustificativaParams): Promise<MovideskTicket[]> {
    try {
      const { limit = 10, justificativas } = params;
      console.error('Buscando tickets Aguardando N1...');

      const response = await this.httpClient.get('/tickets', {
        params: {
          token: this.token,
          $select: 'id,protocol,subject,status,justificativa,createdDate',
          $top: 200,
        },
      });

      const todos = Array.isArray(response.data) ? response.data : [response.data];
      const filtrados = todos
        .filter((t: any) =>
          (t.status || '').toLowerCase() === 'aguardando' &&
          justificativas.some(j => j.toLowerCase() === (t.justificativa || '').toLowerCase())
        )
        .slice(0, limit);

      console.error(`${filtrados.length} tickets Aguardando N1 encontrados`);
      return filtrados;
    } catch (error: any) {
      console.error('Erro:', error.message);
      if (error.response) {
        console.error('HTTP Status:', error.response.status);
        console.error('Data:', JSON.stringify(error.response.data));
      }
      throw error;
    }
  }

  async getTicket(ticketId: string): Promise<MovideskTicket | null> {
    try {
      const response = await this.httpClient.get('/tickets', {
        params: { token: this.token, id: ticketId },
      });
      return response.data;
    } catch (error: any) {
      console.error(`Erro ao buscar ticket ${ticketId}:`, error.message);
      if (error.response) {
        console.error('HTTP Status:', error.response.status);
        console.error('Data:', JSON.stringify(error.response.data));
      }
      return null;
    }
  }

  async createInternalNote(params: CreateNoteParams): Promise<boolean> {
    try {
      console.error(`Criando nota no ticket ${params.ticketId}`);
      const action = { id: 0, type: 2, description: params.description, isInternal: true };
      await this.httpClient.patch(
        `/tickets`,
        { id: params.ticketId, actions: [action] },
        { params: { token: this.token, id: params.ticketId } }
      );
      console.error('Nota criada com sucesso');
      return true;
    } catch (error: any) {
      console.error('Erro ao criar nota:', error.message);
      if (error.response) console.error('Data:', JSON.stringify(error.response.data));
      return false;
    }
  }

  formatN1Note(missingFields: string[]): string {
    return `ANALISE N1 - TICKET INCOMPLETO\n\nFaltam:\n${missingFields.map(f => `- ${f}`).join('\n')}\n\nSolicite as informacoes ao cliente.`;
  }
}

let instance: MovideskClient | null = null;
export function getMovideskClient(): MovideskClient {
  if (!instance) instance = new MovideskClient();
  return instance;
}
