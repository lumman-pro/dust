import {
  Breadcrumbs,
  Button,
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
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Link01,
  RefreshCw01,
  ReverseLeft,
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SpaceClosed,
  Terminal,
  TextArea,
  XClose,
  useCopyToClipboard,
  useSendNotification,
} from "@dust-tt/sparkle";
import { useMemo, useRef, useState } from "react";

import { ConversationView } from "./ConversationView";
import { PanelLayout, PanelLayoutPanel } from "./PanelLayout";
import {
  mockAgents,
  mockSpaces,
  mockUsers,
  type Agent,
  type Conversation,
  type ConversationItem,
} from "../data";

const locutor = mockUsers[0];
const frameAgent =
  mockAgents.find((agent) => agent.name === "ContentWriter") ?? mockAgents[0];

function buildFrameConversation(agent: Agent): Conversation {
  const now = new Date();
  const start = new Date(now.getTime() - 20 * 60 * 1000);

  const messages: ConversationItem[] = [
    { kind: "section", id: "section-today", label: "Today" },
    {
      kind: "message",
      id: "msg-frame-ask",
      content:
        "Turn this week's status into a frame I can share with the pod. Three sections: what shipped, what's blocked, and what's next.",
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
      markdown: `**Weekly status**

What shipped
- Frame preview opens beside the conversation
- Code view copies the source

What's blocked
- Sharing still needs a public link

What's next
- Pin the frame on the pod

The frame is open on the right.`,
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
        { id: "frame-weekly-status", icon: "frame", title: "Weekly status" },
      ],
    },
  ];

  return {
    id: "conv-frame-draft",
    title: "Weekly status frame",
    createdAt: start,
    updatedAt: now,
    userParticipants: [locutor.id],
    agentParticipants: [agent.id],
    messages,
    description: "Draft a weekly status frame for the pod.",
  };
}

export function FrameView() {
  const conversation = useMemo(() => buildFrameConversation(frameAgent), []);
  const randomProjectName = useMemo(() => {
    const randomIndex = Math.floor(Math.random() * mockSpaces.length);
    return mockSpaces[randomIndex]?.name ?? "Pod";
  }, []);
  const [isFrameOpen, setIsFrameOpen] = useState(true);
  const [isDraftMode, setIsDraftMode] = useState(false);
  const [draftConfirm, setDraftConfirm] = useState<
    "cancel" | "validate" | null
  >(null);
  const shownDraftConfirm = useRef<"cancel" | "validate">("cancel");
  if (draftConfirm) {
    shownDraftConfirm.current = draftConfirm;
  }
  const confirmKind = draftConfirm ?? shownDraftConfirm.current;
  const [isAddedToProject, setIsAddedToProject] = useState(false);
  const [isCodeViewOpen, setIsCodeViewOpen] = useState(false);
  const [isCopied, copyToClipboard] = useCopyToClipboard();
  const sendNotification = useSendNotification();
  const frameCode = useMemo(
    () => `export default function FrameTemplate() {
  return (
    <main className="frame-root">
      <h1>Frame preview</h1>
      <p>Prototype content rendered in conversation panel.</p>
    </main>
  );
}`,
    []
  );
  const frameCodeRows = useMemo(
    () => Math.max(frameCode.split("\n").length, 1),
    [frameCode]
  );

  const handleAddToProject = () => {
    if (isAddedToProject) {
      return;
    }

    setIsAddedToProject(true);
    sendNotification({
      type: "success",
      title: `Frame added to project ${randomProjectName}`,
    });
  };

  const handleCopyCode = async () => {
    await copyToClipboard(frameCode);
  };

  const frameActions = (
    <>
      <Button icon={RefreshCw01} size="sm" tooltip="Refresh" variant="ghost" />
      <Button icon={Download01} size="sm" tooltip="Export" variant="ghost" />
      <Button icon={Link01} size="sm" tooltip="Share" variant="ghost" />
      {isDraftMode && (
        <>
          <Button
            icon={XClose}
            label="Cancel draft"
            size="sm"
            variant="outline"
            onClick={() => setDraftConfirm("cancel")}
          />
          <Button
            icon={Check}
            label="Validate draft"
            size="sm"
            variant="highlight"
            onClick={() => setDraftConfirm("validate")}
          />
        </>
      )}
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
          <DropdownMenuItem label="Revert" icon={ReverseLeft} />
          <DropdownMenuItem
            label="Code view"
            icon={Terminal}
            onClick={() => setIsCodeViewOpen(true)}
          />
          <DropdownMenuSeparator />
          <DropdownMenuLabel label="Draft" />
          <DropdownMenuItem
            label={
              isDraftMode ? "De-activate Draft mode" : "Activate Draft mode"
            }
            description={
              isDraftMode
                ? undefined
                : "When in draft mode, modifications are not visible to members until validation of the draft."
            }
            onClick={() => setIsDraftMode((active) => !active)}
          />
          <DropdownMenuSeparator />
          <DropdownMenuLabel
            label={
              isAddedToProject
                ? `Saved to project ${randomProjectName}`
                : `Pod: ${randomProjectName}`
            }
          />
          {!isAddedToProject && (
            <DropdownMenuItem
              label="Add to project"
              icon={SpaceClosed}
              onClick={handleAddToProject}
            />
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );

  return (
    <>
      <PanelLayout>
        <PanelLayoutPanel
          label="Weekly status frame"
          isOpen
          onClose={() => {}}
          topBarLeft={
            <Breadcrumbs
              items={[{ label: "Weekly status frame" }]}
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
            conversationTitle="Weekly status frame"
            onCitationOpen={() => setIsFrameOpen(true)}
          />
        </PanelLayoutPanel>
        <PanelLayoutPanel
          label="Weekly status"
          sizingType="shared"
          fullscreenEnabled
          isOpen={isFrameOpen}
          onClose={() => setIsFrameOpen(false)}
          topBarLeft={
            <Breadcrumbs
              items={[{ label: "Weekly status" }]}
              size="sm"
              hasLighterFont
            />
          }
          topBarRight={frameActions}
        >
          <div className="relative h-full min-h-0 w-full">
            <div
              className={[
                "h-full w-full",
                isDraftMode ? "bg-info p-[6px]" : "",
              ].join(" ")}
            >
              <div
                className={[
                  "h-full w-full bg-background",
                  isDraftMode ? "rounded-lg" : "",
                ].join(" ")}
              />
            </div>
            {isDraftMode && (
              <div className="absolute right-0 top-0 z-10 rounded-bl-lg bg-info px-2 py-1 text-xs font-medium text-golden-950">
                Draft
              </div>
            )}
          </div>
        </PanelLayoutPanel>
      </PanelLayout>
      <Dialog
        open={draftConfirm !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDraftConfirm(null);
          }
        }}
      >
        <DialogContent size="md">
          <DialogHeader>
            <DialogTitle>
              {confirmKind === "validate"
                ? "Validate this draft?"
                : "Cancel this draft?"}
            </DialogTitle>
          </DialogHeader>
          <DialogContainer>
            <DialogDescription className="text-foreground">
              {confirmKind === "validate"
                ? "Validate will modify the frame for all users of the frame."
                : "Cancel will lose all the changes made in this draft."}
            </DialogDescription>
          </DialogContainer>
          <DialogFooter
            leftButtonProps={{
              label: "Keep editing",
              variant: "outline",
              onClick: () => setDraftConfirm(null),
            }}
            rightButtonProps={{
              label:
                confirmKind === "validate" ? "Validate draft" : "Cancel draft",
              variant: confirmKind === "validate" ? "highlight" : "warning",
              onClick: () => {
                setIsDraftMode(false);
                sendNotification({
                  type: "success",
                  title:
                    confirmKind === "validate"
                      ? "Draft validated"
                      : "Draft canceled",
                });
                setDraftConfirm(null);
              },
            }}
          />
        </DialogContent>
      </Dialog>
      <Sheet open={isCodeViewOpen} onOpenChange={setIsCodeViewOpen}>
        <SheetContent size="lg" side="right">
          <SheetHeader>
            <SheetTitle>Frame: Code view</SheetTitle>
          </SheetHeader>
          <div className="flex h-full flex-col gap-3 px-4">
            <div className="flex justify-end">
              <Button
                size="sm"
                variant="outline"
                icon={isCopied ? ClipboardCheck : Clipboard}
                label={isCopied ? "Copied" : "Copy to clipboard"}
                onClick={handleCopyCode}
              />
            </div>
            <TextArea value={frameCode} rows={frameCodeRows} readOnly />
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
