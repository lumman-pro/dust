import {
  FrameSharingList,
  FrameSharingRow,
} from "@app/components/assistant/conversation/interactive_content/frame/FrameSharingRow";
import { Section } from "@app/components/assistant/conversation/interactive_content/frame/ShareFrameSection";
import { compareStrings } from "@app/lib/i18n/format";
import { MAX_EMAILS_OR_DOMAINS_PER_INVITE } from "@app/types/files";
import type {
  FileSharingGrantType,
  SharingGrantsResponse,
} from "@app/types/sharing_grants";
import {
  addSharingGrantsSchema,
  sharingDomainSchema,
  sharingEmailSchema,
} from "@app/types/sharing_grants";
import {
  Button,
  Globe01,
  Input,
  ListGroup,
  LoadingBlock,
} from "@dust-tt/sparkle";
import { zodResolver } from "@hookform/resolvers/zod";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { useId, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { fromError } from "zod-validation-error";

function getRecipientsSchema(t: (descriptor: MessageDescriptor) => string) {
  const maxRecipients = MAX_EMAILS_OR_DOMAINS_PER_INVITE;
  return z
    .string()
    .transform((raw, ctx) => {
      const recipients = raw
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
      if (recipients.length === 0 || recipients.length > maxRecipients) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: t(
            msg`Add between 1 and ${maxRecipients} email addresses or domains.`
          ),
        });
        return z.NEVER;
      }

      const emails: string[] = [];
      const domains: string[] = [];
      for (const recipient of recipients) {
        const email = sharingEmailSchema.safeParse(recipient);
        if (email.success) {
          emails.push(email.data);
          continue;
        }
        const domain = sharingDomainSchema.safeParse(recipient);
        if (domain.success) {
          domains.push(domain.data);
          continue;
        }
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: fromError(domain.error, {
            prefix: `"${recipient}"`,
          }).toString(),
        });
        return z.NEVER;
      }
      return { emails, domains };
    })
    .pipe(addSharingGrantsSchema);
}

function getFormSchema({
  canGrantDomains,
  canInviteExternal,
  t,
}: {
  canGrantDomains: boolean;
  canInviteExternal: boolean;
  t: (descriptor: MessageDescriptor) => string;
}) {
  return z.object({
    recipients: getRecipientsSchema(t).superRefine(({ domains }, ctx) => {
      if (!canGrantDomains && domains?.length) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: canInviteExternal
            ? t(
                msg`Add individual email addresses. Domain sharing is not available.`
              )
            : t(msg`Only workspace member email addresses can be added.`),
        });
      }
    }),
  });
}

interface FrameSharingGrantsProps {
  sharing: SharingGrantsResponse | undefined;
  canInviteExternal: boolean;
  canRevoke: boolean;
  isLoading: boolean;
  hasError: boolean;
  onAdd: (
    recipients: z.infer<typeof addSharingGrantsSchema>
  ) => Promise<boolean>;
  onRevoke: (grantId: string) => Promise<boolean>;
  onRetry: () => void;
}

export function FrameSharingGrants({
  sharing,
  canInviteExternal,
  canRevoke,
  isLoading,
  hasError,
  onAdd,
  onRevoke,
  onRetry,
}: FrameSharingGrantsProps) {
  const { t } = useLingui();
  const inputId = useId();
  const errorId = `${inputId}-error`;
  const canGrantDomains = sharing?.canGrantDomains ?? false;
  const formSchema = useMemo(
    () => getFormSchema({ canGrantDomains, canInviteExternal, t }),
    [canGrantDomains, canInviteExternal, t]
  );
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<z.input<typeof formSchema>, unknown, z.output<typeof formSchema>>(
    {
      resolver: zodResolver(formSchema),
      defaultValues: { recipients: "" },
      mode: "onSubmit",
      reValidateMode: "onSubmit",
    }
  );
  const [revokingIds, setRevokingIds] = useState<string[]>([]);

  const grants = [...(sharing?.accessGrants ?? [])].sort(
    (a, b) =>
      Number(!!a.blockedByPolicy) - Number(!!b.blockedByPolicy) ||
      compareStrings(a.target.value, b.target.value)
  );

  const revoke = async (grant: FileSharingGrantType) => {
    setRevokingIds((ids) => [...ids, grant.sId]);
    try {
      await onRevoke(grant.sId);
    } finally {
      setRevokingIds((ids) => ids.filter((id) => id !== grant.sId));
    }
  };

  const inviteLabel = canGrantDomains
    ? t`Add people or domains`
    : canInviteExternal
      ? t`Invite by email`
      : t`Invite workspace members by email`;

  // The section title, placeholder and validation depend on `canGrantDomains`, only known once
  // loaded: show a placeholder of the same height rather than the form with the wrong copy.
  if (isLoading) {
    return (
      <div role="status" aria-label={t`Loading access rules`}>
        <div aria-hidden="true" className="flex flex-col gap-2">
          <div className="flex h-6 items-center">
            <LoadingBlock className="h-4 w-36" />
          </div>
          <div className="flex gap-2">
            <LoadingBlock className="h-8 flex-1 rounded-xl" />
            <LoadingBlock className="h-8 w-13 rounded-xl" />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <Section
        label={inviteLabel}
        description={
          canGrantDomains
            ? t`Invitations are sent to email addresses only. People at an added domain can open the link after verifying their email.`
            : undefined
        }
      >
        <form
          className="flex flex-col gap-2"
          onSubmit={handleSubmit(async ({ recipients }) => {
            const isAdded = await onAdd(recipients);
            if (isAdded) {
              reset();
            }
          })}
        >
          <div className="flex items-end gap-2">
            <div className="min-w-0 flex-1">
              <Input
                id={inputId}
                aria-label={inviteLabel}
                placeholder={
                  canGrantDomains
                    ? "alice@acme.com, acme.com"
                    : t`Add comma separated emails`
                }
                {...register("recipients")}
                isError={!!errors.recipients}
                aria-invalid={!!errors.recipients}
                aria-describedby={errors.recipients ? errorId : undefined}
                disabled={hasError || isSubmitting}
              />
            </div>
            <Button
              variant="outline"
              label={canGrantDomains ? t`Add` : t`Invite`}
              type="submit"
              isLoading={isSubmitting}
              disabled={hasError}
            />
          </div>
          {errors.recipients && (
            <p id={errorId} role="alert" className="text-xs text-foreground">
              {errors.recipients.message}
            </p>
          )}
        </form>
      </Section>

      {hasError ? (
        <div role="alert" className="flex items-center justify-between gap-2">
          <p className="text-sm text-muted-foreground">
            <Trans>Could not load access rules.</Trans>
          </p>
          <Button label={t`Retry`} variant="outline" onClick={onRetry} />
        </div>
      ) : grants.length === 0 ? null : (
        <ListGroup className="border-0">
          <FrameSharingList label={t`People with access`}>
            {grants.map((grant) => (
              <li key={grant.sId}>
                <GrantRow
                  grant={grant}
                  isRevoking={revokingIds.includes(grant.sId)}
                  onRevoke={canRevoke ? () => revoke(grant) : undefined}
                />
              </li>
            ))}
          </FrameSharingList>
        </ListGroup>
      )}
    </div>
  );
}

interface GrantRowProps {
  grant: FileSharingGrantType;
  isRevoking: boolean;
  onRevoke?: () => void;
}

function GrantRow({ grant, isRevoking, onRevoke }: GrantRowProps) {
  const { t } = useLingui();
  const isDomain = grant.target.kind === "domain";
  const label = isDomain ? `@${grant.target.value}` : grant.target.value;
  const grantedBy = grant.grantedBy?.fullName ?? grant.grantedBy?.email;

  return (
    <FrameSharingRow
      label={label}
      icon={isDomain ? Globe01 : undefined}
      onRemove={onRevoke}
      isRemoving={isRevoking}
    >
      {grantedBy && (
        <span>
          {isDomain ? t`Added by ${grantedBy}` : t`Invited by ${grantedBy}`}
        </span>
      )}
      {grant.blockedByPolicy && (
        <span>
          {isDomain
            ? t`External viewers cannot access this frame.`
            : t`This invitation is restricted to workspace members.`}
        </span>
      )}
    </FrameSharingRow>
  );
}
