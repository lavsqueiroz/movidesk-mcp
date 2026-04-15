/**
 * src/handlers.js
 * Implementação das tools MCP — portada do mcp-queue-server.ts
 * Mantém 100% da lógica original; apenas remove dependência do SDK Stdio
 */

import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ─── helpers ───────────────────────────────────
const N1_JUSTIFICATIVAS = ['Retorno do cliente', 'Retorno NewCon', 'Priorizacao'];
const URGENCY_LABELS    = { 1: 'Simples', 2: 'Moderado', 3: 'Importante', 4: 'Grave' };

function loadPrompt(filename) {
  const p = path.join(__dirname, '../prompts', filename);
  if (!fs.existsSync(p)) throw new Error(`Prompt nao encontrado: ${filename}`);
  return fs.readFileSync(p, 'utf-8');
}

function loadContext(papel) {
  const map = {
    orquestrador: 'ORQUESTRADOR.md',
    n1:     'Agentes/N1_PAPEL.md',
    n2:     'Agentes/N2_PAPEL.md',
    n3:     'Agentes/N3_PAPEL.md',
    admin:  'Agentes/ADMIN_PAPEL.md',
    gestor: 'Agentes/GESTOR_PAPEL.md',
  };
  const content = loadPrompt(map[papel] || 'ORQUESTRADOR.md');
  if (papel === 'gestor') return content;
  return content + '\n\n---\n\n' + loadPrompt('Webhook/AGENTE_WEBHOOK.md');
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split('T')[0];
}

function todayStr() {
  return new Date().toISOString().split('T')[0];
}

function avgOrNull(arr) {
  if (!arr.length) return null;
  return Math.round((arr.reduce((s, v) => s + v, 0) / arr.length) * 100) / 100;
}

// ─── dispatcher principal ───────────────────────
export async function handleTool(name, args, movideskClient) {
  switch (name) {

    case 'get_context': {
      return { content: [{ type: 'text', text: loadContext(args.papel || 'orquestrador') }] };
    }

    case 'list_n1_tickets': {
      const [novos, emAt, aguard] = await Promise.all([
        movideskClient.listTicketsByStatus('Novo'),
        movideskClient.listTicketsByStatus('Em atendimento'),
        movideskClient.listTicketsAguardandoN1(N1_JUSTIFICATIVAS),
      ]);
      return {
        content: [{ type: 'text', text: JSON.stringify({
          total:  novos.length + emAt.length + aguard.length,
          resumo: { novo: novos.length, em_atendimento: emAt.length, aguardando_n1: aguard.length },
          tickets: [
            ...novos.map(t  => ({ ...t, grupo: 'Novo' })),
            ...emAt.map(t   => ({ ...t, grupo: 'Em atendimento' })),
            ...aguard.map(t => ({ ...t, grupo: 'Aguardando' })),
          ],
        }, null, 2) }],
      };
    }

    case 'analyze_ticket_n1': {
      const { ticket_id } = args;
      if (!ticket_id) throw new Error('ticket_id e obrigatorio');
      const ticket = await movideskClient.getTicket(ticket_id);
      if (!ticket) throw new Error(`Ticket ${ticket_id} nao encontrado`);
      const n1Papel   = loadPrompt('Agentes/N1_PAPEL.md');
      const descricao = ticket.actions?.length ? ticket.actions[0].description : 'Sem descricao';
      return {
        content: [{ type: 'text', text:
          `# TICKET ${ticket_id}\n\n` +
          `- ID: ${ticket.id}\n- Assunto: ${ticket.subject}\n- Status: ${ticket.status}\n` +
          `- Justification: ${ticket.justification || 'N/A'}\n- Criado: ${ticket.createdDate}\n\n` +
          `## Descricao\n\n${descricao}\n\n---\n\n## Base N1\n\n${n1Papel}`,
        }],
      };
    }

    case 'create_note_approved': {
      const { ticket_id, note_content } = args;
      if (!ticket_id || !note_content) throw new Error('ticket_id e note_content sao obrigatorios');
      const ok = await movideskClient.createInternalNote({
        ticketId:    ticket_id,
        description: note_content,
        isInternal:  true,
      });
      if (!ok) throw new Error('Falha ao criar nota');
      return {
        content: [{ type: 'text', text: JSON.stringify({
          status:     'success',
          message:    `Nota criada no ticket ${ticket_id}`,
          ticket_url: `https://newm.movidesk.com/Ticket/Edit/${ticket_id}`,
        }, null, 2) }],
      };
    }

    case 'admin_list_tickets': {
      const status = args.status || null;
      const limit  = Math.min(args.limit || 50, 200);
      const tickets = await movideskClient.adminListTickets(status, limit);
      return {
        content: [{ type: 'text', text: JSON.stringify({
          total:         tickets.length,
          filtro_status: status || 'todos',
          tickets: tickets.map(t => ({
            id:            t.id,
            subject:       t.subject,
            status:        t.status,
            justification: t.justification || null,
            createdDate:   t.createdDate,
          })),
        }, null, 2) }],
      };
    }

    case 'admin_get_ticket': {
      const { ticket_id } = args;
      if (!ticket_id) throw new Error('ticket_id e obrigatorio');
      const ticket = await movideskClient.getTicket(ticket_id);
      if (!ticket) throw new Error(`Ticket ${ticket_id} nao encontrado`);
      return { content: [{ type: 'text', text: JSON.stringify(ticket, null, 2) }] };
    }

    case 'export_all_tickets': {
      const dateFrom = args.date_from || daysAgo(60);
      const dateTo   = args.date_to   || todayStr();

      const result = await movideskClient.exportAllTickets({
        status:              args.status || null,
        dateFrom:            null,
        dateTo:              null,
        includeActions:      true,
        includeCustomFields: args.include_custom_fields === true,
        includeClients:      args.include_clients !== false,
      });

      const dateFromTs = new Date(dateFrom + 'T00:00:00.000Z').getTime();
      const dateToTs   = new Date(dateTo   + 'T23:59:59.999Z').getTime();
      const ticketsFiltrados = result.tickets.filter(t => {
        if (!t.createdDate) return false;
        const ts = new Date(t.createdDate).getTime();
        return ts >= dateFromTs && ts <= dateToTs;
      });

      console.error(`EXPORT: Total bruto=${result.tickets.length} | Filtrado ${dateFrom}->${dateTo}: ${ticketsFiltrados.length}`);

      const statusCount = {}, categoryCount = {}, urgencyCount = {}, volumeMensal = {};
      let resolvedInFirstCallCount = 0, withSlaBreached = 0;
      const openStatuses = ['Novo','Em atendimento','Aguardando','Recorrente'];
      const lifeHours = [], stoppedHours = [], abFechHoras = [];
      const distFechamento = { ate_24h: 0, d1_3: 0, d3_7: 0, mais_7d: 0 };

      for (const t of ticketsFiltrados) {
        const s = t.status || 'Desconhecido';
        statusCount[s] = (statusCount[s] || 0) + 1;

        const c = t.category || 'Sem categoria';
        categoryCount[c] = (categoryCount[c] || 0) + 1;

        const uLabel = (t.urgency != null && URGENCY_LABELS[t.urgency])
          ? URGENCY_LABELS[t.urgency]
          : (t.urgency != null ? String(t.urgency) : 'N/D');
        urgencyCount[uLabel] = (urgencyCount[uLabel] || 0) + 1;

        if (t.resolvedInFirstCall) resolvedInFirstCallCount++;
        if (t.slaSolutionDate && new Date(t.slaSolutionDate) < new Date() && openStatuses.includes(t.status || ''))
          withSlaBreached++;

        if (t.createdDate) {
          const d   = new Date(t.createdDate);
          const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
          volumeMensal[key] = (volumeMensal[key] || 0) + 1;
        }

        if (t.lifeTimeWorkingTime   != null) lifeHours.push(t.lifeTimeWorkingTime   / 60);
        if (t.stoppedTimeWorkingTime != null) stoppedHours.push(t.stoppedTimeWorkingTime / 60);

        if (t.lifeTimeWorkingTime != null) {
          const h = t.lifeTimeWorkingTime / 60;
          if      (h <= 24)  distFechamento.ate_24h++;
          else if (h <= 72)  distFechamento.d1_3++;
          else if (h <= 168) distFechamento.d3_7++;
          else               distFechamento.mais_7d++;
        }

        const fim = t.closedIn || t.resolvedIn;
        if (t.createdDate && fim) {
          const h = (new Date(fim).getTime() - new Date(t.createdDate).getTime()) / 3_600_000;
          if (h > 0) abFechHoras.push(h);
        }
      }

      return {
        content: [{ type: 'text', text: JSON.stringify({
          exportedAt:         result.exportedAt,
          total:              ticketsFiltrados.length,
          total_bruto_90d:    result.tickets.length,
          pages_fetched:      result.pages,
          periodo:            { dateFrom, dateTo },
          filtro_aplicado_em: 'memoria (createdDate)',
          resumo: {
            total_tickets:                         ticketsFiltrados.length,
            por_status:                            statusCount,
            por_categoria:                         categoryCount,
            por_urgencia:                          urgencyCount,
            resolvidos_no_primeiro_contato:        resolvedInFirstCallCount,
            tickets_com_sla_vencido:               withSlaBreached,
            volume_mensal:                         volumeMensal,
            tempo_medio_vida_horas:                avgOrNull(lifeHours),
            tempo_medio_parado_horas:              avgOrNull(stoppedHours),
            tempo_medio_abertura_fechamento_horas: avgOrNull(abFechHoras),
            distribuicao_tempo_fechamento:         distFechamento,
            tickets_com_data_fechamento:           ticketsFiltrados.filter(t => t.closedIn || t.resolvedIn).length,
          },
          tickets: ticketsFiltrados,
        }, null, 2) }],
      };
    }

    case 'get_tickets_status_histories': {
      const { ticket_ids, concurrency } = args;
      if (!Array.isArray(ticket_ids) || ticket_ids.length === 0)
        throw new Error('ticket_ids deve ser um array nao vazio');
      const map = await movideskClient.fetchStatusHistoriesBatch(
        ticket_ids,
        Math.min(concurrency || 5, 8)
      );
      return {
        content: [{ type: 'text', text: JSON.stringify({
          total_processados:    Object.keys(map).length,
          status_histories_map: map,
        }, null, 2) }],
      };
    }

    case 'generate_metrics': {
      const { tickets, status_histories_map } = args;
      let ticketArray = tickets;
      if (!Array.isArray(tickets)) {
        if (tickets?.tickets && Array.isArray(tickets.tickets)) {
          ticketArray = tickets.tickets;
        } else {
          throw new Error('Passe um array de tickets, ou o objeto raiz completo do export.');
        }
      }
      if (ticketArray.length === 0) throw new Error('Array de tickets vazio.');
      const metricas = movideskClient.generateMetrics(ticketArray, status_histories_map || undefined);
      return { content: [{ type: 'text', text: JSON.stringify(metricas, null, 2) }] };
    }

    default:
      throw new Error(`Tool desconhecida: ${name}`);
  }
}
