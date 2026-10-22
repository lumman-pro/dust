import {
  Breadcrumbs,
  Button,
  ButtonsSwitch,
  ButtonsSwitchList,
  Check,
  Clipboard,
  ClipboardCheck,
  Dialog,
  DialogContainer,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DotsHorizontal,
  Download01,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  Edit04,
  Eye,
  Globe01,
  LayoutAlt02,
  Link01,
  LinkExternal01,
  Lock01,
  Pin02,
  RefreshCw01,
  ReverseLeft,
  Separator,
  Terminal,
  TextArea,
  Users01,
  XClose,
  useCopyToClipboard,
  useSendNotification,
} from "@dust-tt/sparkle";
import { useMemo, useState } from "react";

import { ConversationView } from "./ConversationView";
import { PanelLayout, PanelLayoutPanel } from "./PanelLayout";
import {
  mockAgents,
  mockUsers,
  type Agent,
  type Conversation,
  type ConversationItem,
} from "../data";

const locutor = mockUsers[0];
const frameAgent =
  mockAgents.find((agent) => agent.name === "ContentWriter") ?? mockAgents[0];

const SHARE_URL = "https://dust.tt/share/frame/board-q4-report";

type FrameMode = "view" | "code" | "edit";
type ShareScope = "invite" | "workspace" | "public";
type DraftConfirm = "cancel" | "validate" | "deactivate";

interface BoardReport {
  title: string;
  period: string;
  summary: string;
  metrics: { label: string; value: string; note: string }[];
  landed: string[];
  risks: string[];
  ask: string;
}

const INITIAL_REPORT: BoardReport = {
  title: "Board Q4 report",
  period: "October 2026",
  summary:
    "Revenue held the plan, pipeline is ahead of the quarter, and the board is asked to approve the Q1 hiring plan.",
  metrics: [
    { label: "Revenue", value: "$4.8M", note: "+18% vs Q3" },
    { label: "Pipeline", value: "$12.1M", note: "Qualified" },
    { label: "Net retention", value: "118%", note: "Trailing twelve months" },
  ],
  landed: [
    "Closed the two enterprise renewals that were open at the Q3 review.",
    "Shipped frame sharing to every workspace on the new plan.",
    "Cut median time to first answer from 6.2s to 4.1s.",
  ],
  risks: [
    "One strategic account is in a procurement pause until January.",
    "Support load grew faster than the team.",
  ],
  ask: "Approve four hires for Q1: two on support, one on sales, one on product.",
};

function buildFrameConversation(agent: Agent): Conversation {
  const now = new Date();
  const start = new Date(now.getTime() - 20 * 60 * 1000);

  const messages: ConversationItem[] = [
    { kind: "section", id: "section-today", label: "Today" },
    {
      kind: "message",
      id: "msg-frame-ask",
      content:
        "Turn the Q4 numbers into a frame I can share with the board. Revenue, what landed, the risks, and the ask.",
      timestamp: new Date(start.getTime() + 2 * 60 * 1000),
      ownerId: locutor.id,
      ownerType: "user",
      type: "user",
      group: {
        id: "g-locutor",
        type: "locutor",
        timestamp: "16:42",
      },
    },
    {
      kind: "message",
      id: "msg-frame-draft",
      markdown: `**Board Q4 report**

The frame is open on the right. It covers revenue, what landed, the risks, and the hiring ask.`,
      timestamp: new Date(start.getTime() + 4 * 60 * 1000),
      ownerId: agent.id,
      ownerType: "agent",
      type: "agent",
      group: {
        id: "g-agent",
        type: "agent",
        name: agent.name,
        timestamp: "16:44",
        completionStatus: "Completed in 8 sec",
        avatar: {
          emoji: agent.emoji,
          backgroundColor: agent.backgroundColor,
        },
      },
      citations: [
        { id: "frame-board-q4", icon: "frame", title: "Board Q4 report" },
      ],
    },
  ];

  return {
    id: "conv-frame-draft",
    title: "Board Q4 report",
    createdAt: start,
    updatedAt: now,
    userParticipants: [locutor.id],
    agentParticipants: [agent.id],
    messages,
    description: "Share the Q4 board report as a frame.",
  };
}

function EditableText({
  value,
  editing,
  className,
  onChange,
}: {
  value: string;
  editing: boolean;
  className?: string;
  onChange: (value: string) => void;
}) {
  return (
    <div
      className={[
        className,
        editing ? "cursor-text rounded-sm outline-none" : "",
      ].join(" ")}
      contentEditable={editing}
      suppressContentEditableWarning
      onBlur={(event) => {
        const next = event.currentTarget.textContent ?? "";
        if (next !== value) {
          onChange(next);
        }
      }}
    >
      {value}
    </div>
  );
}

function BoardReportView({
  report,
  editing,
  onChange,
}: {
  report: BoardReport;
  editing: boolean;
  onChange: (report: BoardReport) => void;
}) {
  const update = (patch: Partial<BoardReport>) =>
    onChange({ ...report, ...patch });

  return (
    <div className="h-full overflow-auto bg-background px-8 py-7">
      <p className="text-xs font-medium text-muted-foreground">Board report</p>
      <EditableText
        value={report.title}
        editing={editing}
        className="mt-1 text-2xl font-semibold tracking-tight"
        onChange={(title) => update({ title })}
      />
      <p className="mt-1 text-sm text-muted-foreground">{report.period}</p>
      <EditableText
        value={report.summary}
        editing={editing}
        className="mt-4 max-w-xl text-sm leading-6"
        onChange={(summary) => update({ summary })}
      />
      <div className="mt-6 grid grid-cols-3 gap-3">
        {report.metrics.map((metric, index) => (
          <div key={metric.label} className="rounded-xl border px-4 py-3">
            <p className="text-xs text-muted-foreground">{metric.label}</p>
            <EditableText
              value={metric.value}
              editing={editing}
              className="mt-1 text-xl font-semibold"
              onChange={(value) => {
                const metrics = report.metrics.map((item, itemIndex) =>
                  itemIndex === index ? { ...item, value } : item
                );
                update({ metrics });
              }}
            />
            <p className="mt-1 text-xs text-muted-foreground">{metric.note}</p>
          </div>
        ))}
      </div>
      <h2 className="mt-8 text-sm font-semibold">What landed</h2>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-sm leading-6">
        {report.landed.map((item, index) => (
          <li key={index}>
            <EditableText
              value={item}
              editing={editing}
              onChange={(value) => {
                const landed = report.landed.map((entry, entryIndex) =>
                  entryIndex === index ? value : entry
                );
                update({ landed });
              }}
            />
          </li>
        ))}
      </ul>
      <h2 className="mt-6 text-sm font-semibold">Risks</h2>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-sm leading-6">
        {report.risks.map((item, index) => (
          <li key={index}>
            <EditableText
              value={item}
              editing={editing}
              onChange={(value) => {
                const risks = report.risks.map((entry, entryIndex) =>
                  entryIndex === index ? value : entry
                );
                update({ risks });
              }}
            />
          </li>
        ))}
      </ul>
      <h2 className="mt-6 text-sm font-semibold">Ask</h2>
      <EditableText
        value={report.ask}
        editing={editing}
        className="mt-2 max-w-xl text-sm leading-6"
        onChange={(ask) => update({ ask })}
      />
    </div>
  );
}

export function FrameView() {
  const conversation = useMemo(() => buildFrameConversation(frameAgent), []);
  const [isFrameOpen, setIsFrameOpen] = useState(true);
  const [mode, setMode] = useState<FrameMode>("view");
  const [hasDraft, setHasDraft] = useState(false);
  const [isDraftMode, setIsDraftMode] = useState(false);
  const [prodReport, setProdReport] = useState<BoardReport>(INITIAL_REPORT);
  const [draftReport, setDraftReport] = useState<BoardReport>(INITIAL_REPORT);
  // Working copy of a direct edit: unsaved, so it never touches prodReport
  // until Save.
  const [directReport, setDirectReport] = useState<BoardReport | null>(null);
  // The kind outlives the open state so the dialog keeps its copy while it
  // animates closed.
  const [confirmKind, setConfirmKind] = useState<DraftConfirm>("cancel");
  const [isConfirmOpen, setIsConfirmOpen] = useState(false);
  const [shareScope, setShareScope] = useState<ShareScope>("workspace");
  const [isPinned, setIsPinned] = useState(false);
  const [isPodTab, setIsPodTab] = useState(false);
  const [isCopied, copyToClipboard] = useCopyToClipboard();
  const sendNotification = useSendNotification();
  const frameCode = useMemo(
    () => `export default function BoardQ4Report() {
  return (
    <main className="frame-root">
      <h1>Board Q4 report</h1>
      <p>Revenue, what landed, the risks, and the hiring ask.</p>
    </main>
  );
}`,
    []
  );
  const frameCodeRows = useMemo(
    () => Math.max(frameCode.split("\n").length, 1),
    [frameCode]
  );

  const editing = mode === "edit";
  const isDirectEditing = editing && !isDraftMode;
  const displayedReport = isDraftMode
    ? draftReport
    : (directReport ?? prodReport);

  const updateDisplayedReport = (next: BoardReport) => {
    if (isDraftMode) {
      setDraftReport(next);
      return;
    }
    setDirectReport(next);
  };

  const handleModeChange = (next: string) => {
    if (next !== "view" && next !== "code" && next !== "edit") {
      return;
    }
    if (next === "edit") {
      if (hasDraft && !isDraftMode) {
        setIsDraftMode(true);
      } else if (!isDraftMode) {
        setDirectReport(prodReport);
      }
    } else {
      // Leaving edit without saving drops the direct-edit changes.
      setDirectReport(null);
      if (next === "view") {
        setIsDraftMode(false);
      }
    }
    setMode(next);
  };

  const handleSaveDirectEdit = () => {
    if (directReport) {
      setProdReport(directReport);
    }
    setDirectReport(null);
    setMode("view");
    sendNotification({ type: "success", title: "Changes saved" });
  };

  const handleCancelDirectEdit = () => {
    setDirectReport(null);
    setMode("view");
  };

  const openConfirm = (kind: DraftConfirm) => {
    setConfirmKind(kind);
    setIsConfirmOpen(true);
  };

  const handleValidateDraft = () => {
    setProdReport(draftReport);
    setHasDraft(false);
    setIsDraftMode(false);
    setDirectReport(null);
    setMode("view");
    sendNotification({ type: "success", title: "Draft validated" });
    setIsConfirmOpen(false);
  };

  const handleCancelDraft = () => {
    setDraftReport(prodReport);
    setHasDraft(false);
    setIsDraftMode(false);
    setDirectReport(null);
    setMode("view");
    sendNotification({ type: "success", title: "Draft canceled" });
    setIsConfirmOpen(false);
  };

  const handleKeepDraft = () => {
    setIsDraftMode(false);
    setDirectReport(null);
    setMode("view");
    setIsConfirmOpen(false);
  };

  const handleToggleDraftMode = () => {
    if (isDraftMode) {
      openConfirm("deactivate");
      return;
    }
    if (!hasDraft) {
      // A direct edit in progress becomes the draft.
      setDraftReport(directReport ?? prodReport);
      setHasDraft(true);
    }
    setDirectReport(null);
    setIsDraftMode(true);
    setMode("edit");
  };

  const keepEditing = {
    label: "Keep editing",
    variant: "outline" as const,
    onClick: () => setIsConfirmOpen(false),
  };
  const cancelDraft = {
    label: "Cancel draft",
    variant: "warning" as const,
    onClick: handleCancelDraft,
  };
  const confirmCopy = {
    validate: {
      title: "Validate this draft?",
      description: "Validate will modify the frame for all users of the frame.",
      left: keepEditing,
      right: {
        label: "Validate draft",
        variant: "highlight" as const,
        onClick: handleValidateDraft,
      },
    },
    cancel: {
      title: "Cancel this draft?",
      description: "Cancel will lose all the changes made in this draft.",
      left: keepEditing,
      right: cancelDraft,
    },
    deactivate: {
      title: "Leave Draft mode?",
      description:
        "Keep the draft to come back to it later, or cancel it to lose the changes made in it.",
      left: {
        label: "Keep the draft",
        variant: "outline" as const,
        onClick: handleKeepDraft,
      },
      right: cancelDraft,
    },
  }[confirmKind];

  const handleCopyCode = async () => {
    await copyToClipboard(frameCode);
  };

  // Draft mode and a direct edit share the same framed chrome, in their own color.
  const isFramed = isDraftMode || isDirectEditing;

  const handleCopyShareLink = async () => {
    await copyToClipboard(SHARE_URL);
    sendNotification({
      type: "success",
      title: "Link copied",
    });
  };

  const frameActions = (
    <>
      <ButtonsSwitchList
        size="sm"
        value={mode}
        onValueChange={handleModeChange}
      >
        <ButtonsSwitch value="view" icon={Eye} tooltip="View" />
        <ButtonsSwitch value="code" icon={Terminal} tooltip="Code" />
        <ButtonsSwitch value="edit" icon={Edit04} tooltip="Edit" />
      </ButtonsSwitchList>
      <div
        className={[
          "grid transition-[grid-template-columns,opacity] duration-[260ms] ease-[cubic-bezier(.4,0,.2,1)] motion-reduce:transition-none",
          isFramed
            ? "grid-cols-[1fr] opacity-100"
            : "pointer-events-none grid-cols-[0fr] opacity-0",
        ].join(" ")}
      >
        <div className="flex items-center gap-1 overflow-hidden">
          <Button
            icon={XClose}
            label="Cancel"
            size="sm"
            variant="outline"
            onClick={
              isDraftMode ? () => openConfirm("cancel") : handleCancelDirectEdit
            }
          />
          <Button
            icon={Check}
            label={isDraftMode ? "Validate" : "Save"}
            size="sm"
            variant="highlight"
            onClick={
              isDraftMode ? () => openConfirm("validate") : handleSaveDirectEdit
            }
          />
        </div>
      </div>
      <Separator orientation="vertical" className="h-5 self-center" />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            icon={Download01}
            size="sm"
            tooltip="Export"
            variant="ghost"
            aria-label="Export"
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuSub>
            <DropdownMenuSubTrigger label="PDF" />
            <DropdownMenuSubContent>
              <DropdownMenuItem
                label="Portrait"
                onClick={() =>
                  sendNotification({
                    type: "success",
                    title: "Exported as PDF, portrait",
                  })
                }
              />
              <DropdownMenuItem
                label="Landscape"
                onClick={() =>
                  sendNotification({
                    type: "success",
                    title: "Exported as PDF, landscape",
                  })
                }
              />
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuItem
            label="PNG"
            onClick={() =>
              sendNotification({ type: "success", title: "Exported as PNG" })
            }
          />
          <DropdownMenuItem
            label="Source (.zip)"
            onClick={() =>
              sendNotification({
                type: "success",
                title: "Exported source",
              })
            }
          />
        </DropdownMenuContent>
      </DropdownMenu>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            icon={Users01}
            size="sm"
            tooltip="Share"
            variant="ghost"
            aria-label="Share"
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            label="Copy link"
            icon={Link01}
            onClick={() => {
              void handleCopyShareLink();
            }}
          />
          <DropdownMenuSeparator />
          <DropdownMenuRadioGroup
            value={shareScope}
            onValueChange={(value) => {
              if (
                value === "invite" ||
                value === "workspace" ||
                value === "public"
              ) {
                setShareScope(value);
              }
            }}
          >
            <DropdownMenuLabel label="Who has access" />
            <DropdownMenuRadioItem
              value="invite"
              label="Invite only"
              icon={Lock01}
            />
            <DropdownMenuRadioItem
              value="workspace"
              label="All workspace members + invites"
              icon={Users01}
            />
            <DropdownMenuRadioItem
              value="public"
              label="Anyone with the link"
              icon={Globe01}
            />
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            aria-label="More actions"
            icon={DotsHorizontal}
            size="sm"
            variant="ghost"
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem
            label="Revert the last change"
            icon={ReverseLeft}
            onClick={() =>
              sendNotification({
                type: "success",
                title: "Reverted the last change",
              })
            }
          />
          <DropdownMenuSeparator />
          <DropdownMenuLabel label="Draft" />
          <DropdownMenuItem
            label={
              isDraftMode ? "De-activate Draft mode" : "Activate Draft mode"
            }
            onClick={handleToggleDraftMode}
          />
          {!isDraftMode &&
            (hasDraft ? (
              <p className="w-[240px] px-2 pb-2 text-xs font-semibold text-foreground">
                One draft ongoing
              </p>
            ) : (
              <p className="w-[240px] px-2 pb-2 text-xs font-normal text-muted-foreground">
                Your changes stay hidden from other members until you validate
                the draft.
              </p>
            ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            label={isPinned ? "Unpin from Pod banner" : "Pin as Pod banner"}
            icon={Pin02}
            onClick={() => {
              setIsPinned((pinned) => !pinned);
              sendNotification({
                type: "success",
                title: isPinned
                  ? "Unpinned from Pod banner"
                  : "Pinned as Pod banner",
              });
            }}
          />
          <DropdownMenuItem
            label={isPodTab ? "Remove from Pod tabs" : "Add as Pod tab"}
            icon={LayoutAlt02}
            onClick={() => {
              setIsPodTab((added) => !added);
              sendNotification({
                type: "success",
                title: isPodTab ? "Removed from Pod tabs" : "Added as Pod tab",
              });
            }}
          />
        </DropdownMenuContent>
      </DropdownMenu>
      <Separator orientation="vertical" className="h-5 self-center" />
      <Button
        icon={LinkExternal01}
        size="sm"
        tooltip="Open in a new tab"
        variant="ghost"
        onClick={() =>
          sendNotification({
            type: "success",
            title: "Opened in a new tab",
          })
        }
      />
      <Button icon={RefreshCw01} size="sm" tooltip="Refresh" variant="ghost" />
    </>
  );

  return (
    <>
      <PanelLayout>
        <PanelLayoutPanel
          label="Board Q4 report"
          isOpen
          onClose={() => {}}
          topBarLeft={
            <Breadcrumbs
              items={[{ label: "Board Q4 report" }]}
              size="sm"
              hasLighterFont
            />
          }
        >
          <ConversationView
            conversation={conversation}
            locutor={locutor}
            users={mockUsers}
            agents={[frameAgent]}
            conversationsWithMessages={[]}
            conversationTitle="Board Q4 report"
            onCitationOpen={() => setIsFrameOpen(true)}
          />
        </PanelLayoutPanel>
        <PanelLayoutPanel
          label="Board Q4 report"
          sizingType="shared"
          fullscreenEnabled
          isOpen={isFrameOpen}
          onClose={() => setIsFrameOpen(false)}
          topBarLeft={
            <Breadcrumbs
              items={[{ label: "Board Q4 report" }]}
              size="sm"
              hasLighterFont
            />
          }
          topBarRight={frameActions}
        >
          <div className="relative h-full min-h-0 w-full">
            <div
              className={[
                "h-full w-full transition-[padding,background-color] duration-[260ms] ease-[cubic-bezier(.4,0,.2,1)] motion-reduce:transition-none",
                isDraftMode ? "bg-info" : "bg-highlight",
                isFramed ? "p-[6px]" : "p-0",
              ].join(" ")}
            >
              <div
                className={[
                  "h-full w-full overflow-hidden bg-background transition-[border-radius] duration-[260ms] ease-[cubic-bezier(.4,0,.2,1)] motion-reduce:transition-none",
                  isFramed ? "rounded-lg" : "rounded-none",
                ].join(" ")}
              >
                {mode === "code" ? (
                  <div className="flex h-full flex-col gap-3 overflow-auto bg-background p-4">
                    <div className="flex justify-end">
                      <Button
                        size="sm"
                        variant="outline"
                        icon={isCopied ? ClipboardCheck : Clipboard}
                        label={isCopied ? "Copied" : "Copy to clipboard"}
                        onClick={() => {
                          void handleCopyCode();
                        }}
                      />
                    </div>
                    <TextArea value={frameCode} rows={frameCodeRows} readOnly />
                  </div>
                ) : (
                  <BoardReportView
                    // Remount on every state change: contentEditable text is
                    // owned by the DOM once typed, so canceling must rebuild it.
                    key={`${isDraftMode ? "draft" : "prod"}-${editing ? "edit" : "read"}`}
                    report={displayedReport}
                    editing={editing}
                    onChange={updateDisplayedReport}
                  />
                )}
              </div>
            </div>
            <div
              aria-hidden={!isFramed}
              className={[
                "absolute right-0 top-0 z-10 rounded-bl-lg px-2 py-1 text-xs font-medium transition-[opacity,translate,background-color] duration-[260ms] ease-[cubic-bezier(.4,0,.2,1)] motion-reduce:transition-none",
                isDraftMode
                  ? "bg-info text-golden-950"
                  : "bg-highlight text-white",
                isFramed
                  ? "translate-y-0 opacity-100"
                  : "pointer-events-none -translate-y-2 opacity-0",
              ].join(" ")}
            >
              {isDraftMode ? "Draft" : "Edit"}
            </div>
          </div>
        </PanelLayoutPanel>
      </PanelLayout>
      <Dialog
        open={isConfirmOpen}
        onOpenChange={(open) => {
          if (!open) {
            setIsConfirmOpen(false);
          }
        }}
      >
        <DialogContent size="md">
          <DialogHeader>
            <DialogTitle>{confirmCopy.title}</DialogTitle>
          </DialogHeader>
          <DialogContainer>
            <DialogDescription className="text-foreground">
              {confirmCopy.description}
            </DialogDescription>
          </DialogContainer>
          <DialogFooter
            leftButtonProps={confirmCopy.left}
            rightButtonProps={confirmCopy.right}
          />
        </DialogContent>
      </Dialog>
    </>
  );
}
