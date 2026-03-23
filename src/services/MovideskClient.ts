/**
 * Movidesk API Client
 */

import axios, { AxiosInstance } from 'axios';

export interface MovideskTicket {
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

  /**
   * Lista tickets filtrando por status localmente
   */
  async listTicketsByStatus(status: string, limit: number = 10): Promise<MovideskTicket[]> {
    try {
      console.error(`Buscando tickets status=${status}...`);
      const response = await this.httpClient.get('/tickets', {
        params: {
          token: this.token,
          $select: 'id,protocol,subject,status,createdDate',
          $top: 200,
        },
      });
      const all = Array.isArray(response.data) ? response.data : [response.data];
      const filtered = all
        .filter((t: any) => (t.status || '').toLowerCase() === status.toLowerCase())
        .slice(0, limit);
      console.error(`${filtered.length} tickets com status=${status}`);
      return filtered;
    } catch (error: any) {
      console.error('Erro ao listar tickets:', error.message);
      if (error.response) console.error('HTTP:', error.response.status, JSON.stringify(error.response.data));
      throw error;
    }
  }

  /**
   * Lista tickets Aguardando filtrados por justificativas do N1
   */
  async listTicketsAguardandoN1(justificativas: string[], limit: number = 10): Promise<MovideskTicket[]> {
    try {
      console.error('Buscando tickets Aguardando N1...');
      const response = await this.httpClient.get('/tickets', {
        params: {
          token: this.token,
          $select: 'id,protocol,subject,status,justificativa,createdDate',
          $top: 200,
        },
      });
      const all = Array.isArray(response.data) ? response.data : [response.data];
      const filtered = all
        .filter((t: any) =>
          (t.status || '').toLowerCase() === 'aguardando' &&
          justificativas.some(j => j.toLowerCase() === (t.justificativa || '').toLowerCase())
        )
        .slice(0, limit);
      console.error(`${filtered.length} tickets Aguardando N1`);
      return filtered;
    } catch (error: any) {
      console.error('Erro:', error.message);
      if (error.response) console.error('HTTP:', error.response.status, JSON.stringify(error.response.data));
      throw error;
    }
  }

  /**
   * ADMIN: Lista todos os tickets, com filtro de status opcional
   */
  async adminListTickets(status: string | null, limit: number = 50): Promise<MovideskTicket[]> {
    try {
      console.error(`ADMIN: Buscando tickets... status=${status || 'todos'}`);
      const response = await this.httpClient.get('/tickets', {
        params: {
          token: this.token,
          $select: 'id,protocol,subject,status,justificativa,createdDate',
          $top: 500,
        },
      });
      let all = Array.isArray(response.data) ? response.data : [response.data];
      if (status) {
        all = all.filter((t: any) => (t.status || '').toLowerCase() === status.toLowerCase());
      }
      const result = all.slice(0, limit);
      console.error(`${result.length} tickets retornados`);
      return result;
    } catch (error: any) {
      console.error('Erro ADMIN:', error.message);
      if (error.response) console.error('HTTP:', error.response.status, JSON.stringify(error.response.data));
      throw error;
    }
  }

  /**
   * Busca ticket por ID
   */
  async getTicket(ticketId: string): Promise<MovideskTicket | null> {
    try {
      const response = await this.httpClient.get('/tickets', {
        params: { token: this.token, id: ticketId },
      });
      return response.data;
    } catch (error: any) {
      console.error(`Erro ao buscar ticket ${ticketId}:`, error.message);
      if (error.response) console.error('HTTP:', error.response.status, JSON.stringify(error.response.data));
      return null;
    }
  }

  /**
   * Cria nota interna no ticket
   */
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
      if (error.response) console.error('HTTP:', error.response.status, JSON.stringify(error.response.data));
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
