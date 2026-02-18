// src/app/api/webhook/route.ts
import { supabaseServer } from "@/lib/supabase-server";

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => null);
    if (!body) return Response.json({ ok: true });

    const msg = body.message ?? body;

    // -------------------------------
    // Extracting assistantId
    // -------------------------------
    const assistantId =
      msg?.assistant?.id ||
      msg?.chat?.assistantId ||
      msg?.call?.assistantId ||
      msg?.artifact?.call?.assistantId ||
      null;

    if (!assistantId) return Response.json({ ok: true });

    const { data: client } = await supabaseServer
      .from("clients")
      .select("id, chat_serial_counter")
      .eq("vapi_agent_id", assistantId)
      .single();

    if (!client) return Response.json({ ok: true });

    const clientId = client.id;

    // =====================================================================
    // HANDLE TOOL CALLS (MANDATORY)
    // =====================================================================
    if (msg.type === "tool-calls" && Array.isArray(msg.toolCallList)) {
      const results = msg.toolCallList.map((tc: any) => ({
        name: tc.name,
        toolCallId: tc.id,
        result: JSON.stringify({ status: "received" }),
      }));
      return Response.json({ results });
    }

    // ===================================================
    // =============== 1. CHAT LOGGING ===================
    // ===================================================
    if (msg.chat) {
      const chat = msg.chat;
      const sessionId = chat.sessionId;

      const { data: existingSessionRow } = await supabaseServer
        .from("chat_usage")
        .select("chat_serial")
        .eq("session_id", sessionId)
        .eq("client_id", clientId)
        .limit(1)
        .maybeSingle();

      const { data: anyChatForClient } = await supabaseServer
        .from("chat_usage")
        .select("id")
        .eq("client_id", clientId)
        .limit(1);

      const isFirstChatForClient =
        !anyChatForClient || anyChatForClient.length === 0;

      let chatSerial: number;

      if (existingSessionRow?.chat_serial) {
        chatSerial = Number(existingSessionRow.chat_serial);
      } else {
        const baseCounter = isFirstChatForClient
          ? 0
          : client.chat_serial_counter ?? 0;

        chatSerial = baseCounter + 1;

        await supabaseServer
          .from("clients")
          .update({ chat_serial_counter: chatSerial })
          .eq("id", clientId);
      }

      const { data: existingMessages } = await supabaseServer
        .from("chat_usage")
        .select("message, sender")
        .eq("client_id", clientId)
        .eq("session_id", sessionId);

      const seen = new Set<string>();
      for (const row of existingMessages ?? []) {
        seen.add(`${row.sender}|||${row.message}`);
      }

      function normalize(list: any[]) {
        if (!Array.isArray(list)) return [];
        return list
          .map((m) => {
            const role = m?.role;
            const text = m?.content;

            if (role !== "user" && role !== "assistant") return null;
            if (!text || typeof text !== "string") return null;

            const key = `${role}|||${text}`;
            if (seen.has(key)) return null;
            seen.add(key);

            return {
              client_id: clientId,
              assistant_id: assistantId,
              session_id: sessionId,
              chat_serial: chatSerial,
              message: text,
              sender: role,
              appointment_success: false,
              created_at: new Date().toISOString(),
            };
          })
          .filter(Boolean);
      }

      const rows = [
        ...normalize(chat.messages ?? []),
        ...normalize(chat.output ?? []),
      ];

      if (rows.length > 0) {
        await supabaseServer.from("chat_usage").insert(rows);
      }

      let appointmentSuccess = false;

      for (const out of chat.output ?? []) {
        if (out.role === "tool") {
          try {
            const parsed = JSON.parse(out.content);
            if (parsed?.status === "confirmed") appointmentSuccess = true;
          } catch {}
        }

        if (
          out.role === "assistant" &&
          typeof out.content === "string" &&
          out.content.toLowerCase().includes("appointment") &&
          out.content.toLowerCase().includes("confirmed")
        ) {
          appointmentSuccess = true;
        }
      }

      if (appointmentSuccess) {
        await supabaseServer
          .from("chat_usage")
          .update({ appointment_success: true })
          .eq("session_id", sessionId)
          .eq("client_id", clientId)
          .eq("assistant_id", assistantId);
      }
    }

    // ===================================================
    // =============== 2. CALL INGESTION =================
    // ===================================================
    const callObj = msg.call ?? msg.artifact?.call ?? null;

    if (callObj) {
      const callId =
        callObj.id ||
        msg.callId ||
        msg.artifact?.call?.id ||
        null;

      if (callId) {
        const started =
          callObj.startedAt ||
          callObj.start_time ||
          callObj.createdAt ||
          callObj.created_at ||
          null;

        const ended =
          callObj.endedAt ||
          callObj.end_time ||
          callObj.completedAt ||
          callObj.completed_at ||
          null;

        // 🔑 FIX: VAPI often sends duration directly even when endedAt is null
        const durationSeconds =
          Number(callObj.durationSeconds) ||
          (Number(callObj.durationMs)
            ? Math.floor(Number(callObj.durationMs) / 1000)
            : 0);

        const durationMinutesExact = durationSeconds
          ? Number((durationSeconds / 60).toFixed(1))
          : 0;

        const minutesRounded = Math.ceil(durationMinutesExact || 0);

        // ===============================
        // APPOINTMENT DETECTION (CALLS)
        // ===============================
        let appointmentDetected = false;

        const structured =
          msg.structuredOutputs ??
          msg.artifact?.structuredOutputs ??
          null;

        if (structured && typeof structured === "object") {
          for (const key of Object.keys(structured)) {
            const entry = structured[key];
            if (
              entry?.name === "Appointment Booked" &&
              entry?.result === true
            ) {
              appointmentDetected = true;
              break;
            }
          }
        }

        if (!appointmentDetected) {
          const allMsg = [
            ...(msg.artifact?.messages ?? []),
            ...(msg.output ?? []),
            ...(msg.messages ?? []),
          ];

          for (const item of allMsg) {
            if (
              item.role === "tool_call_result" &&
              item.name === "google_calendar_tool"
            ) {
              try {
                const parsed = JSON.parse(item.result);
                if (parsed?.status === "confirmed") {
                  appointmentDetected = true;
                  break;
                }
              } catch {}
            }
          }
        }

        const { data: existing } = await supabaseServer
          .from("usage")
          .select("appointment_success")
          .eq("vapi_call_id", callId)
          .maybeSingle();

        const appointmentSuccess =
          existing?.appointment_success === true
            ? true
            : appointmentDetected;

        const payload = {
          vapi_call_id: callId,
          client_id: clientId,
          assistant_id: assistantId,

          minutes: minutesRounded,
          duration_seconds: durationSeconds,
          duration_minutes_exact: durationMinutesExact,

          start_time: started ? new Date(started).toISOString() : null,
          end_time: ended ? new Date(ended).toISOString() : null,

          appointment_success: appointmentSuccess,
          source: "calls",
          created_at: new Date().toISOString(),
        };

        await supabaseServer
          .from("usage")
          .upsert(payload, { onConflict: "vapi_call_id" });
      }
    }

    return Response.json({ ok: true });
  } catch (err) {
    console.error("🔥 WEBHOOK ERROR:", err);
    return Response.json({ ok: false }, { status: 200 });
  }
}
