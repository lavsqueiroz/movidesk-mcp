/**
 * Movidesk API Client
 */

import axios, { AxiosInstance } from 'axios';

interface MovideskTicket {
  id: string;
  protocol?: string;
  subject?: string;
  status?: string;
  justification?: string;
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

  // Busca tickets por status usando $filter correto da API
  async listTicketsByStatus(status: string, limit = 10): Promise<MovideskTicket[]> {
    try {
      console.error(`Buscando tickets status=${status}...`);
      const response = await this.httpClient.get('/tickets', {
        params: {
          token: this.token,
          $select: 'id,protocol,subject,status,justification,createdDate',
          $top: limit,
          $filter: `status eq '${status}'`,
        },
      });
      const tickets = Array.isArray(response.data) ? response.data : [response.data];
      console.error(`${tickets.length} tickets retornados`);
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

  // Busca tickets Aguardando e filtra por justificativas N1 localmente
  async listTicketsAguardandoN1(justificativas: string[], limit = 10): Promise<MovideskTicket[]> {
    try {
      console.error('Buscando tickets Aguardando...');
      const response = await this.httpClient.get('/tickets', {
        params: {
          token: this.token,
          $select: 'id,protocol,subject,status,justification,createdDate',
          $top: 100,
          $filter: `status eq 'Aguardando'`,
        },
      });
      const todos = Array.isArray(response.data) ? response.data : [response.data];
      const filtrados = todos
        .filter((t: any) => justificativas.includes(t.justification || ''))
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

  // Busca ticket por ID
  async getTicket(ticketId: string): Promise<MovideskTicket | null> {
    try {
      const response = await this.httpClient.get('/tickets', {
        params: {
          token: this.token,
          id: ticketId,
          $select: 'id,protocol,subject,status,justification,createdDate,actions',
        },
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

  // Cria nota interna no ticket
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
}

let instance: MovideskClient | null = null;
export function getMovideskClient(): MovideskClient {
  if (!instance) instance = new MovideskClient();
  return instance;
}
