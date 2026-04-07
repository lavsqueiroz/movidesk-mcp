/**
 * Movidesk API Client v2.9.1
 *
 * NOTAS DA API MOVIDESK:
 * - /tickets sem filtro retorna apenas tickets com lastUpdate nos ultimos 90 dias
 * - $filter por createdDate filtra data de criacao (pode excluir tickets antigos ainda ativos)
 * - $filter por lastUpdate filtra ultima atualizacao (melhor para "ativos nos ultimos N dias")
 * - $orderby NAO pode ser usado junto com $filter (retorna 0 resultados silenciosamente)
 * - $top maximo: 1000 por pagina
 * - $skip: paginacao offset
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

export interface StatusHistory {
  status: string;
  justification?: string;
  permanencyTimeWorkingTime?: number; // minutos uteis
  permanencyTime?: number;            // minutos totais
  date?: string;
}

export interface MovideskTicketFull {
  id: string;
  protocol?: string;
  subject?: string;
  status?: string;
  justification?: string;
  baseStatus?: string;
  createdDate?: string;
  lastUpdate?: string;
  resolvedIn?: string;
  closedIn?: string;
  canceledIn?: string;
  origin?: number;
  type?: number;
  urgency?: number;
  category?: string;
  owner?: any;
  ownerTeam?: string;
  createdBy?: any;
  clients?: any[];
  actions?: any[];
  customFieldValues?: any[];
  tags?: string[];
  slaSolutionDate?: string;
  slaSolutionDateIsPaused?: boolean;
  slaResponseDate?: string;
  lifeTimeWorkingTime?: number;
  stoppedTime?: number;
  stoppedTimeWorkingTime?: number;
  resolvedInFirstCall?: boolean;
  reopenedIn?: string;
  statusHistories?: StatusHistory[];
}

export interface ExportAllTicketsParams {
  status?: string | null;
  dateFrom?: string | null;    // filtra por lastUpdate >= dateFrom (tickets atualizados a partir desta data)
  dateTo?: string | null;      // filtra por lastUpdate <= dateTo
  includeActions?: boolean;
  includeCustomFields?: boolean;
  includeClients?: boolean;
}

export interface ExportAllTicketsResult {
  total: number;
  pages: number;
  filters: Record<string, any>;
  exportedAt: string;
  tickets: MovideskTicketFull[];
}

export interface TempoStats {
  media_horas: number;
  minimo_horas: number;
  maximo_horas: number;
  amostras: number;
}

export interface DistribuicaoFaixa {
  ate_2h: number;
  de_2h_a_8h: number;
  de_8h_a_24h: number;
  acima_24h: number;
}

export interface MetricasResult {
  gerado_em: string;
  total_tickets: number;
  periodo: { mais_antigo: string | null; mais_recente: string | null };
  tempo_resposta_cliente: TempoStats & { distribuicao_por_faixa: DistribuicaoFaixa };
  tempo_em_atendimento: TempoStats;
  tempo_aguardando_retorno_cliente: TempoStats;
  tempo_triagem_ate_analise_projetos: TempoStats;
  percentual_volta_falta_info: { quantidade: number; percentual: number; justificativas_encontradas: string[] };
  tempo_em_analise_projetos: TempoStats;
  tempo_retorno_com_direcionamento: TempoStats;
  interacoes_com_cliente: { media_por_ticket: number; maximo: number; ticket_mais_interacoes: string | null; distribuicao: Record<string, number> };
  tickets_encerrados: { resolvidos: number; fechados: number; total_encerrados: number; percentual_sobre_total: number };
  transicao_novo_para_em_atendimento: TempoStats;
  transicao_em_atendimento_para_aguardando: TempoStats;
  tempo_por_justificativa_aguardando: Record<string, TempoStats>;
  aguardando_por_justificativa: Record<string, { quantidade: number; percentual: number }>;
}

interface CreateNoteParams {
  ticketId: string;
  description: string;
  isInternal: boolean;
}

const SELECT_REPORT_BASE = [
  'id','protocol','subject','status','baseStatus','justification',
  'type','urgency','origin','category',
  'createdDate','lastUpdate','resolvedIn','closedIn','canceledIn','reopenedIn',
  'slaSolutionDate','slaSolutionDateIsPaused','slaResponseDate',
  'lifeTimeWorkingTime','stoppedTime','stoppedTimeWorkingTime',
  'resolvedInFirstCall','ownerTeam','owner','createdBy','tags',
].join(',');

const SELECT_WITH_CLIENTS = SELECT_REPORT_BASE + ',clients';
const SELECT_WITH_CUSTOM  = SELECT_REPORT_BASE + ',customFieldValues';
const SELECT_FULL         = SELECT_REPORT_BASE + ',clients,customFieldValues,actions';

function diffHoras(a: string | undefined, b: string | undefined): number | null {
  if (!a || !b) return null;
  const da = new Date(a).getTime(), db = new Date(b).getTime();
  if (isNaN(da) || isNaN(db)) return null;
  return Math.abs(db - da) / 3_600_000;
}

function statsDeArray(valores: number[]): TempoStats {
  if (valores.length === 0) return { media_horas: 0, minimo_horas: 0, maximo_horas: 0, amostras: 0 };
  const soma = valores.reduce((s, v) => s + v, 0);
  return {
    media_horas:  Math.round((soma / valores.length) * 100) / 100,
    minimo_horas: Math.round(Math.min(...valores) * 100) / 100,
    maximo_horas: Math.round(Math.max(...valores) * 100) / 100,
    amostras:     valores.length,
  };
}

export class MovideskClient {
  private httpClient: AxiosInstance;
  private token: string;

  constructor() {
    this.token = process.env.MOVIDESK_TOKEN || '';
    if (!this.token) throw new Error('MOVIDESK_TOKEN nao configurado');
    this.httpClient = axios.create({
      baseURL: 'https://api.movidesk.com/public/v1',
      timeout: 60000,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  async listTicketsByStatus(status: string): Promise<MovideskTicket[]> {
    try {
      const response = await this.httpClient.get('/tickets', {
        params: {
          token: this.token,
          $select: 'id,protocol,subject,status,justification,createdDate',
          $filter: `status eq '${status}'`,
          $top: 1000,
        },
      });
      return Array.isArray(response.data) ? response.data : [response.data];
    } catch (error: any) {
      console.error('Erro ao listar tickets:', error.message);
      throw error;
    }
  }

  async listTicketsAguardandoN1(justificativas: string[]): Promise<MovideskTicket[]> {
    try {
      const response = await this.httpClient.get('/tickets', {
        params: {
          token: this.token,
          $select: 'id,protocol,subject,status,justification,createdDate',
          $filter: `status eq 'Aguardando'`,
          $top: 1000,
        },
      });
      const all = Array.isArray(response.data) ? response.data : [response.data];
      return all.filter((t: any) =>
        justificativas.some(j => j.toLowerCase() === (t.justification || '').toLowerCase())
      );
    } catch (error: any) {
      console.error('Erro:', error.message);
      throw error;
    }
  }

  async adminListTickets(status: string | null, limit: number = 50): Promise<MovideskTicket[]> {
    try {
      const params: any = {
        token: this.token,
        $select: 'id,protocol,subject,status,justification,createdDate',
        $top: limit,
      };
      if (status) params.$filter = `status eq '${status}'`;
      const response = await this.httpClient.get('/tickets', { params });
      return Array.isArray(response.data) ? response.data : [response.data];
    } catch (error: any) {
      console.error('Erro ADMIN:', error.message);
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
      return null;
    }
  }

  async exportAllTickets(params: ExportAllTicketsParams = {}): Promise<ExportAllTicketsResult> {
    const {
      status = null,
      dateFrom = null,
      dateTo = null,
      includeActions = false,
      includeCustomFields = false,
      includeClients = true,
    } = params;

    let selectFields: string;
    if (includeActions)                            selectFields = SELECT_FULL;
    else if (includeClients && includeCustomFields) selectFields = SELECT_REPORT_BASE + ',clients,customFieldValues';
    else if (includeClients)                       selectFields = SELECT_WITH_CLIENTS;
    else if (includeCustomFields)                  selectFields = SELECT_WITH_CUSTOM;
    else                                           selectFields = SELECT_REPORT_BASE;

    // FIX: usar lastUpdate para filtrar tickets "ativos nos ultimos N dias"
    // createdDate filtraria apenas tickets CRIADOS nesse periodo, excluindo tickets
    // antigos que continuam sendo movimentados. lastUpdate captura todos os tickets
    // que tiveram qualquer atividade no periodo.
    // FIX: $orderby NAO pode ser combinado com $filter na API do Movidesk
    // (retorna 0 resultados silenciosamente). Removido $orderby quando ha filtros.
    const filters: string[] = [];
    if (status)   filters.push(`status eq '${status}'`);
    if (dateFrom) filters.push(`lastUpdate ge '${dateFrom}T00:00:00'`);
    if (dateTo)   filters.push(`lastUpdate le '${dateTo}T23:59:59'`);
    const $filter = filters.length > 0 ? filters.join(' and ') : undefined;

    const PAGE_SIZE = 1000;
    let skip = 0, page = 1;
    let allTickets: MovideskTicketFull[] = [];
    let hasMore = true;

    console.error(`EXPORT: Iniciando. Filtros: status=${status||'todos'} | lastUpdate de ${dateFrom||'sem limite'} ate ${dateTo||'sem limite'}`);

    while (hasMore) {
      console.error(`EXPORT: Pagina ${page} (skip=${skip})...`);

      // IMPORTANTE: so incluir $orderby quando NAO ha $filter ativo
      const requestParams: any = {
        token: this.token,
        $select: selectFields,
        $top: PAGE_SIZE,
        $skip: skip,
      };
      if ($filter) {
        requestParams.$filter = $filter;
        // sem $orderby quando ha $filter
      } else {
        requestParams.$orderby = 'lastUpdate desc';
      }

      try {
        const response = await this.httpClient.get('/tickets', { params: requestParams });
        const data = Array.isArray(response.data) ? response.data : [response.data];

        if (data.length === 0 || (data.length === 1 && !data[0]?.id)) {
          hasMore = false;
          break;
        }

        allTickets = allTickets.concat(data);
        console.error(`EXPORT: Pagina ${page} -> ${data.length} tickets | Acumulado: ${allTickets.length}`);

        if (data.length < PAGE_SIZE) {
          hasMore = false;
        } else {
          skip += PAGE_SIZE;
          page++;
          await new Promise(r => setTimeout(r, 300));
        }
      } catch (error: any) {
        console.error(`EXPORT: Erro pagina ${page}:`, error.message);
        if (error.response) console.error('HTTP:', error.response.status, JSON.stringify(error.response.data));
        hasMore = false;
      }
    }

    console.error(`EXPORT: Concluido! ${allTickets.length} tickets em ${page} paginas.`);
    return {
      total: allTickets.length,
      pages: page,
      filters: {
        status: status || 'todos',
        dateFrom: dateFrom || 'sem filtro',
        dateTo: dateTo || 'sem filtro',
        campo_data_filtrado: 'lastUpdate',
        includeActions,
        includeCustomFields,
        includeClients,
      },
      exportedAt: new Date().toISOString(),
      tickets: allTickets,
    };
  }

  /**
   * Busca statusHistories de uma lista de IDs em lote com concorrencia controlada.
   * statusHistories so existe no endpoint individual do ticket (/tickets?id=X).
   * Retorna map: ticketId -> StatusHistory[]
   */
  async fetchStatusHistoriesBatch(
    ticketIds: string[],
    concurrency: number = 5
  ): Promise<Record<string, StatusHistory[]>> {
    console.error(`STATUS_HIST: Buscando historico de ${ticketIds.length} tickets (concorrencia=${concurrency})...`);
    const result: Record<string, StatusHistory[]> = {};
    let idx = 0;

    const processOne = async (id: string) => {
      try {
        const response = await this.httpClient.get('/tickets', {
          params: { token: this.token, id },
        });
        result[id] = Array.isArray(response.data?.statusHistories) ? response.data.statusHistories : [];
      } catch (e: any) {
        console.error(`STATUS_HIST: Erro ticket ${id}:`, e.message);
        result[id] = [];
      }
    };

    while (idx < ticketIds.length) {
      const batch = ticketIds.slice(idx, idx + concurrency);
      await Promise.all(batch.map(id => processOne(id)));
      idx += concurrency;
      if (idx < ticketIds.length) await new Promise(r => setTimeout(r, 200));
      if (idx % 50 === 0) console.error(`STATUS_HIST: Progresso ${idx}/${ticketIds.length}`);
    }

    console.error(`STATUS_HIST: Concluido. ${Object.keys(result).length} tickets processados.`);
    return result;
  }

  generateMetrics(tickets: MovideskTicketFull[], statusHistoriesMap?: Record<string, StatusHistory[]>): MetricasResult {
    console.error(`METRICS: Calculando metricas para ${tickets.length} tickets...`);

    const JUSTIFICATIVAS_FALTA_INFO = [
      'falta de informacao','falta informacao','aguardando informacao',
      'info incompleta','sem informacao','informacao pendente',
    ];
    const STATUS_ANALISE        = 'Analise Projetos';
    const STATUS_EM_ATENDIMENTO = 'Em atendimento';
    const STATUS_AGUARDANDO     = 'Aguardando';

    const temposResposta: number[] = [], temposEmAtendimento: number[] = [];
    const temposAguardandoRetorno: number[] = [], temposTriagem: number[] = [];
    const temposAnalise: number[] = [], temposDirecionamento: number[] = [];
    const interacoesPorTicket: { id: string; count: number }[] = [];

    const transNovoParaAtendimento: number[]       = [];
    const transAtendimentoParaAguardando: number[] = [];
    const tempoPorJustificativa: Record<string, number[]> = {};
    const aguardandoPorJustificativa: Record<string, number> = {};

    let voltaFaltaInfo = 0;
    const justificativasEncontradas = new Set<string>();
    let resolvidos = 0, fechados = 0;

    const distribuicaoInteracoes: Record<string, number> = { '0': 0, '1-3': 0, '4-6': 0, '7-10': 0, 'acima-10': 0 };
    const faixaResposta: DistribuicaoFaixa = { ate_2h: 0, de_2h_a_8h: 0, de_8h_a_24h: 0, acima_24h: 0 };
    const datas: Date[] = [];

    for (const ticket of tickets) {
      if (ticket.createdDate) datas.push(new Date(ticket.createdDate));
      if (ticket.status === 'Resolvido') resolvidos++;
      if (ticket.status === 'Fechado')   fechados++;

      const just = (ticket.justification || '').toLowerCase();
      if (JUSTIFICATIVAS_FALTA_INFO.some(j => just.includes(j))) {
        voltaFaltaInfo++;
        justificativasEncontradas.add(ticket.justification || '');
      }

      // ---- StatusHistories ----
      const histories: StatusHistory[] = statusHistoriesMap?.[ticket.id] ?? ticket.statusHistories ?? [];

      for (let i = 0; i < histories.length; i++) {
        const h = histories[i], next = histories[i + 1];

        if (h.status === 'Novo' && next?.status === STATUS_EM_ATENDIMENTO) {
          const min = h.permanencyTimeWorkingTime ?? h.permanencyTime;
          if (min != null && min >= 0) transNovoParaAtendimento.push(min / 60);
        }
        if (h.status === STATUS_EM_ATENDIMENTO && next?.status === STATUS_AGUARDANDO) {
          const min = h.permanencyTimeWorkingTime ?? h.permanencyTime;
          if (min != null && min >= 0) transAtendimentoParaAguardando.push(min / 60);
        }
        if (h.status === STATUS_AGUARDANDO) {
          const justLabel = h.justification || 'Sem justificativa';
          const min = h.permanencyTimeWorkingTime ?? h.permanencyTime;
          if (min != null && min >= 0) {
            if (!tempoPorJustificativa[justLabel]) tempoPorJustificativa[justLabel] = [];
            tempoPorJustificativa[justLabel].push(min / 60);
          }
        }
      }

      if (ticket.status === STATUS_AGUARDANDO) {
        const j = ticket.justification || 'Sem justificativa';
        aguardandoPorJustificativa[j] = (aguardandoPorJustificativa[j] || 0) + 1;
      }

      // ---- Actions ----
      const actions: any[] = ticket.actions || [];

      const primeiraPublica = actions
        .filter(a => a.type === 2 || a.isInternal === false)
        .sort((a, b) => new Date(a.createdDate || a.date || 0).getTime() - new Date(b.createdDate || b.date || 0).getTime())[0];

      const diffResp = diffHoras(ticket.createdDate, primeiraPublica?.createdDate || primeiraPublica?.date);
      if (diffResp !== null && diffResp >= 0) {
        temposResposta.push(diffResp);
        if (diffResp <= 2)       faixaResposta.ate_2h++;
        else if (diffResp <= 8)  faixaResposta.de_2h_a_8h++;
        else if (diffResp <= 24) faixaResposta.de_8h_a_24h++;
        else                     faixaResposta.acima_24h++;
      }

      let ultimaData = ticket.createdDate;
      for (const action of [...actions].sort((a, b) =>
        new Date(a.createdDate || a.date || 0).getTime() - new Date(b.createdDate || b.date || 0).getTime()
      )) {
        const actionDate     = action.createdDate || action.date;
        const statusAnterior = action.statusBefore || action.previousStatus;
        const statusNovo     = action.status || action.statusAfter;
        if (statusAnterior && statusNovo && ultimaData && actionDate) {
          const diff = diffHoras(ultimaData, actionDate);
          if (diff !== null && diff > 0) {
            if (statusAnterior === STATUS_EM_ATENDIMENTO) temposEmAtendimento.push(diff);
            if (statusAnterior === STATUS_AGUARDANDO && ['retorno','return'].some(k => (action.justification || just).toLowerCase().includes(k)))
              temposAguardandoRetorno.push(diff);
            if (statusAnterior === STATUS_ANALISE) temposAnalise.push(diff);
          }
        }
        if (actionDate) ultimaData = actionDate;
      }

      const actionAnalise = [...actions]
        .filter(a => (a.status || a.statusAfter || '').toLowerCase().includes('analise'))
        .sort((a, b) => new Date(a.createdDate || a.date || 0).getTime() - new Date(b.createdDate || b.date || 0).getTime())[0];

      const diffTriagem = diffHoras(ticket.createdDate, actionAnalise?.createdDate || actionAnalise?.date);
      if (diffTriagem !== null && diffTriagem >= 0) temposTriagem.push(diffTriagem);

      if (actionAnalise) {
        const dataAnalise = actionAnalise.createdDate || actionAnalise.date;
        const retornoPos = [...actions]
          .filter(a => {
            const d = a.createdDate || a.date;
            return (a.type === 2 || a.isInternal === false) && d && new Date(d) > new Date(dataAnalise);
          })
          .sort((a, b) => new Date(a.createdDate || a.date || 0).getTime() - new Date(b.createdDate || b.date || 0).getTime())[0];
        const diffDir = diffHoras(ticket.createdDate, retornoPos?.createdDate || retornoPos?.date);
        if (diffDir !== null && diffDir >= 0) temposDirecionamento.push(diffDir);
      }

      const publicActions = actions.filter(a => a.type === 2 || a.isInternal === false);
      const count = publicActions.length;
      interacoesPorTicket.push({ id: ticket.id, count });
      if (count === 0)      distribuicaoInteracoes['0']++;
      else if (count <= 3)  distribuicaoInteracoes['1-3']++;
      else if (count <= 6)  distribuicaoInteracoes['4-6']++;
      else if (count <= 10) distribuicaoInteracoes['7-10']++;
      else                  distribuicaoInteracoes['acima-10']++;
    }

    const maxInteracao = [...interacoesPorTicket].sort((a, b) => b.count - a.count)[0];
    const mediaInteracoes = interacoesPorTicket.length > 0
      ? Math.round((interacoesPorTicket.reduce((s, t) => s + t.count, 0) / interacoesPorTicket.length) * 100) / 100
      : 0;

    const totalEncerrados = resolvidos + fechados;
    datas.sort((a, b) => a.getTime() - b.getTime());

    const tempoPorJustificativaStats: Record<string, TempoStats> = {};
    for (const [label, valores] of Object.entries(tempoPorJustificativa)) {
      tempoPorJustificativaStats[label] = statsDeArray(valores);
    }

    const totalAguardando = Object.values(aguardandoPorJustificativa).reduce((s, v) => s + v, 0);
    const aguardandoPorJustResult: Record<string, { quantidade: number; percentual: number }> = {};
    for (const [label, qtd] of Object.entries(aguardandoPorJustificativa)) {
      aguardandoPorJustResult[label] = {
        quantidade: qtd,
        percentual: totalAguardando > 0 ? Math.round((qtd / totalAguardando) * 10000) / 100 : 0,
      };
    }

    console.error('METRICS: Concluido.');
    return {
      gerado_em: new Date().toISOString(),
      total_tickets: tickets.length,
      periodo: {
        mais_antigo:  datas.length > 0 ? datas[0].toISOString() : null,
        mais_recente: datas.length > 0 ? datas[datas.length - 1].toISOString() : null,
      },
      tempo_resposta_cliente: { ...statsDeArray(temposResposta), distribuicao_por_faixa: faixaResposta },
      tempo_em_atendimento: statsDeArray(temposEmAtendimento),
      tempo_aguardando_retorno_cliente: statsDeArray(temposAguardandoRetorno),
      tempo_triagem_ate_analise_projetos: statsDeArray(temposTriagem),
      percentual_volta_falta_info: {
        quantidade: voltaFaltaInfo,
        percentual: tickets.length > 0 ? Math.round((voltaFaltaInfo / tickets.length) * 10000) / 100 : 0,
        justificativas_encontradas: Array.from(justificativasEncontradas),
      },
      tempo_em_analise_projetos: statsDeArray(temposAnalise),
      tempo_retorno_com_direcionamento: statsDeArray(temposDirecionamento),
      interacoes_com_cliente: {
        media_por_ticket: mediaInteracoes,
        maximo: maxInteracao?.count || 0,
        ticket_mais_interacoes: maxInteracao?.id || null,
        distribuicao: distribuicaoInteracoes,
      },
      tickets_encerrados: {
        resolvidos,
        fechados,
        total_encerrados: totalEncerrados,
        percentual_sobre_total: tickets.length > 0 ? Math.round((totalEncerrados / tickets.length) * 10000) / 100 : 0,
      },
      transicao_novo_para_em_atendimento: statsDeArray(transNovoParaAtendimento),
      transicao_em_atendimento_para_aguardando: statsDeArray(transAtendimentoParaAguardando),
      tempo_por_justificativa_aguardando: tempoPorJustificativaStats,
      aguardando_por_justificativa: aguardandoPorJustResult,
    };
  }

  async createInternalNote(params: CreateNoteParams): Promise<boolean> {
    try {
      const action = { id: 0, type: 1, description: params.description, isInternal: true };
      await this.httpClient.patch(
        '/tickets',
        { id: params.ticketId, actions: [action] },
        { params: { token: this.token, id: params.ticketId } }
      );
      return true;
    } catch (error: any) {
      console.error('Erro ao criar nota:', error.message);
      return false;
    }
  }
}

let instance: MovideskClient | null = null;
export function getMovideskClient(): MovideskClient {
  if (!instance) instance = new MovideskClient();
  return instance;
}
