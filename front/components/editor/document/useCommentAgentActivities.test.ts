import { AGENT_EDIT_SHOWN_MS } from "@app/components/editor/document/AgentCarets";
import {
  READ_THEN_THINKING_MS,
  RUN_SHOWN_MS,
  useCommentAgentActivities,
  workingCommentAgent,
} from "@app/components/editor/document/useCommentAgentActivities";
import type { DfmComment, DfmMessage } from "@app/lib/markdown/dfm";
import { CollabAgentFactory } from "@app/tests/utils/CollabAgentFactory";
import { fakeCommentChannel } from "@app/tests/utils/FakeCommentChannel";
import type { AgentActivity, CollabAgent } from "@app/types/collab";
import {
  HocuspocusProvider,
  HocuspocusProviderWebsocket,
} from "@hocuspocus/provider";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const providers: HocuspocusProvider[] = [];

function fakeProvider() {
  const provider = new HocuspocusProvider({
    name: "document",
    websocketProvider: new HocuspocusProviderWebsocket({
      url: "ws://localhost",
      autoConnect: false,
    }),
  });
  providers.push(provider);
  const announce = (agent: CollabAgent, activity: AgentActivity) =>
    act(() =>
      provider.receiveStateless(
        JSON.stringify({ type: "agent_activity", agent, activity })
      )
    );
  return { provider, announce };
}

const message = (author: DfmMessage["author"]): DfmMessage => ({
  author,
  createdAt: "2026-10-05T12:00:00.000Z",
  body: "Done.",
});

const TOM = message({ kind: "user", id: "usr_tom", name: "Tom" });

function fakeComments(initial: DfmComment[]) {
  const { channel, push } = fakeCommentChannel(initial);
  const post = (commentId: string, added: DfmMessage) =>
    act(() =>
      push(
        (channel.getThreads() ?? []).map((thread) =>
          thread.id === commentId
            ? { ...thread, messages: [...thread.messages, added] }
            : thread
        )
      )
    );
  return { comments: channel, post };
}

const thread = (id: string): DfmComment => ({
  id,
  status: "open",
  messages: [TOM],
});

describe("useCommentAgentActivities", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    providers.splice(0).forEach((provider) => provider.destroy());
    vi.useRealTimers();
  });

  it("shows each thread's last activity", () => {
    const { provider, announce } = fakeProvider();
    const agent = CollabAgentFactory.build({ commentId: "c1" });
    const other = CollabAgentFactory.build({ commentId: "c2" });
    const { result } = renderHook(() =>
      useCommentAgentActivities(provider, null)
    );

    announce(agent, "thinking");
    announce(other, "thinking");
    announce(agent, "reading");
    expect(result.current.get("c1")).toEqual({ agent, activity: "reading" });
    expect(result.current.get("c2")).toEqual({
      agent: other,
      activity: "thinking",
    });
  });

  it("shows a thread's activity until its agent replies in it", () => {
    const { provider, announce } = fakeProvider();
    const { comments, post } = fakeComments([thread("c1")]);
    const agent = CollabAgentFactory.build({ commentId: "c1" });
    const { result } = renderHook(() =>
      useCommentAgentActivities(provider, comments)
    );

    announce(agent, "thinking");
    post("c1", TOM);
    post("c1", message({ kind: "agent", id: "other", name: "@Other" }));
    expect(result.current.has("c1")).toBe(true);

    post("c1", message({ kind: "agent", id: agent.agentId, name: "@Writer" }));
    expect(result.current.has("c1")).toBe(false);
  });

  it("keeps a waiting agent through replies, and ends it on its reply once it runs", () => {
    const { provider, announce } = fakeProvider();
    const { comments, post } = fakeComments([thread("c1")]);
    const agent = CollabAgentFactory.build({ commentId: "c1" });
    const reply = message({
      kind: "agent",
      id: agent.agentId,
      name: "@Writer",
    });
    const { result } = renderHook(() =>
      useCommentAgentActivities(provider, comments)
    );

    announce(agent, "waiting");
    post("c1", reply);
    expect(result.current.get("c1")?.activity).toBe("waiting");

    announce(agent, "thinking");
    post("c1", TOM);
    expect(result.current.get("c1")?.activity).toBe("thinking");
    post("c1", reply);
    expect(result.current.has("c1")).toBe(false);
  });

  it("goes back to thinking after a read or an edit", () => {
    const { provider, announce } = fakeProvider();
    const agent = CollabAgentFactory.build({ commentId: "c1" });
    const { result } = renderHook(() =>
      useCommentAgentActivities(provider, null)
    );

    announce(agent, "reading");
    act(() => vi.advanceTimersByTime(READ_THEN_THINKING_MS - 1));
    expect(result.current.get("c1")?.activity).toBe("reading");
    act(() => vi.advanceTimersByTime(1));
    expect(result.current.get("c1")?.activity).toBe("thinking");

    announce(agent, "editing");
    act(() => vi.advanceTimersByTime(AGENT_EDIT_SHOWN_MS - 1));
    expect(result.current.get("c1")?.activity).toBe("editing");
    act(() => vi.advanceTimersByTime(1));
    expect(result.current.get("c1")?.activity).toBe("thinking");
  });

  it("counts replies from the first threads when none had arrived yet", () => {
    const { provider, announce } = fakeProvider();
    const { channel, push } = fakeCommentChannel();
    const agent = CollabAgentFactory.build({ commentId: "c1" });
    const reply = message({
      kind: "agent",
      id: agent.agentId,
      name: "@Writer",
    });
    const { result } = renderHook(() =>
      useCommentAgentActivities(provider, channel)
    );

    announce(agent, "thinking");
    act(() => push([{ ...thread("c1"), messages: [TOM, reply] }]));
    expect(result.current.get("c1")?.activity).toBe("thinking");

    act(() => push([{ ...thread("c1"), messages: [TOM, reply, reply] }]));
    expect(result.current.has("c1")).toBe(false);
  });

  it("ignores an agent that answers no thread", () => {
    const { provider, announce } = fakeProvider();
    const { result } = renderHook(() =>
      useCommentAgentActivities(provider, null)
    );

    announce(CollabAgentFactory.build(), "reading");
    expect(result.current.size).toBe(0);
  });

  it("stops showing a run that never replies", () => {
    const { provider, announce } = fakeProvider();
    const { result } = renderHook(() =>
      useCommentAgentActivities(provider, null)
    );

    announce(CollabAgentFactory.build({ commentId: "c1" }), "thinking");
    act(() => vi.advanceTimersByTime(RUN_SHOWN_MS));
    expect(result.current.size).toBe(0);
  });

  it("starts with nothing on a new provider", () => {
    const first = fakeProvider();
    const second = fakeProvider();
    const { result, rerender } = renderHook(
      ({ provider }) => useCommentAgentActivities(provider, null),
      { initialProps: { provider: first.provider } }
    );

    first.announce(CollabAgentFactory.build({ commentId: "c1" }), "thinking");
    rerender({ provider: second.provider });
    expect(result.current.size).toBe(0);
  });
});

describe("workingCommentAgent", () => {
  it("gives a thread's agent that is not waiting", () => {
    const waiting = CollabAgentFactory.build({ commentId: "c1" });
    const reading = CollabAgentFactory.build({ commentId: "c2" });

    expect(
      workingCommentAgent(
        new Map([
          ["c1", { agent: waiting, activity: "waiting" }],
          ["c2", { agent: reading, activity: "reading" }],
        ])
      )
    ).toEqual({ agent: reading, activity: "reading" });
    expect(
      workingCommentAgent(
        new Map([["c1", { agent: waiting, activity: "waiting" }]])
      )
    ).toBeNull();
  });
});
