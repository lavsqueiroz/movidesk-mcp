/**
 * Movidesk API Client
 * Documentacao: https://atendimento.movidesk.com/kb/pt-br/article/256/movidesk-ticket-api
 *
 * Campos confirmados pela documentacao:
 * - id, protocol, subject, status, justification, createdDate
 * - $select obrigatorio ao listar multiplos tickets
 * - $filter suporta OData: status eq 'Novo', justification eq 'Retorno do cliente'
 * - $top: limite de registros por request
 * - Nota interna: PATCH /tickets com action type=2, isInternal=true
 * - Rota /tickets retorna tickets com lastupdate < 90 dias
 */

import axios, { AxiosInstance } from 'axios';

export interface MovideskTicket {
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

  /**
   * Lista tickets filtrando por status via $filter da API
   * Mais eficiente e preciso do que filtrar localmente
   */
  async listTicketsByStatus(status: string, limit: number = 10): Promise<MovideskTicket[]> {
    try {
      console.error(`Buscando tickets status=${status}...`);
      const response = await this.httpClient.get('/tickets', {
        params: {
          token: this.token,
          $select: 'id,protocol,subject,status,justification,createdDate',
          $filter: `status eq '${status}'`,
          $top: limit,
        },
      });
      const tickets = Array.isArray(response.data) ? response.data : [response.data];
      console.error(`${tickets.length} tickets com status=${status}`);
      return tickets;
    } catch (error: any) {
      console.error('Erro ao listar tickets:', error.message);
      if (error.response) console.error('HTTP:', error.response.status, JSON.stringify(error.response.data));
      throw error;
    }
  }

  /**
   * Lista tickets Aguardando com justificativas do N1 via $filter da API
   * Justificativas N1 (nomes exatos do Movidesk):
   *   - Retorno do cliente
   *   - Retorno NewCon
   *   - Priorizacao
   */
  async listTicketsAguardandoN1(justificativas: string[], limit: number = 10): Promise<MovideskTicket[]> {
    try {
      console.error('Buscando tickets Aguardando N1...');

      // Busca todos os Aguardando e filtra localmente pelas justificativas
      // pois OData nao suporta bem o OR em justification na API do Movidesk
      const response = await this.httpClient.get('/tickets', {
        params: {
          token: this.token,
          $select: 'id,protocol,subject,status,justification,createdDate',
          $filter: `status eq 'Aguardando'`,
          $top: 200,
        },
      });

      const all = Array.isArray(response.data) ? response.data : [response.data];
      const filtered = all
        .filter((t: any) =>
          justificativas.some(j =>
            j.toLowerCase() === (t.justification || '').toLowerCase()
          )
        )
        .slice(0, limit);

      console.error(`${filtered.length} tickets Aguardando N1 (de ${all.length} Aguardando total)`);
      return filtered;
    } catch (error: any) {
      console.error('Erro:', error.message);
      if (error.response) console.error('HTTP:', error.response.status, JSON.stringify(error.response.data));
      throw error;
    }
  }

  /**
   * ADMIN: Lista tickets com filtro de status opcional via $filter da API
   */
  async adminListTickets(status: string | null, limit: number = 50): Promise<MovideskTicket[]> {
    try {
      console.error(`ADMIN: Buscando tickets... status=${status || 'todos'}`);

      const params: any = {
        token: this.token,
        $select: 'id,protocol,subject,status,justification,createdDate',
        $top: limit,
      };

      if (status) {
        params.$filter = `status eq '${status}'`;
      }

      const response = await this.httpClient.get('/tickets', { params });
      const tickets = Array.isArray(response.data) ? response.data : [response.data];
      console.error(`${tickets.length} tickets retornados`);
      return tickets;
    } catch (error: any) {
      console.error('Erro ADMIN:', error.message);
      if (error.response) console.error('HTTP:', error.response.status, JSON.stringify(error.response.data));
      throw error;
    }
  }

  /**
   * Busca ticket completo por ID (sem $select para retornar todos os campos incluindo actions)
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
   * Documentacao confirma: type=2 = nota interna, isInternal=true
   * id=0 = nova action (nao alteracao)
   */
  async createInternalNote(params: CreateNoteParams): Promise<boolean> {
    try {
      console.error(`Criando nota no ticket ${params.ticketId}`);
      const action = {
        id: 0,       // 0 = nova action
        type: 2,     // 2 = nota interna (confirmado pela documentacao)
        description: params.description,
        isInternal: true,
      };
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
}

let instance: MovideskClient | null = null;
export function getMovideskClient(): MovideskClient {
  if (!instance) instance = new MovideskClient();
  return instance;
}
