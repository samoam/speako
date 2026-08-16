import { registerDraftKind } from '../registry';
import { teamsReplyDraft } from './teamsReplyDraft';
import { emailReplyDraft } from './emailReplyDraft';
import { jiraActionDraft } from './jiraActionDraft';
import { confluencePageDraft } from './confluencePageDraft';
import { confluenceDevCycleDraft } from './confluenceDevCycleDraft';
import { gitBranchCreateDraft } from './gitBranchCreateDraft';
import { devPlanDraft } from './devPlanDraft';
import { jiraTransitionDraft } from './jiraTransitionDraft';
import { bitbucketPrCommentDraft } from './bitbucketPrCommentDraft';
import { prOpenDraft } from './prOpenDraft';
import { jenkinsFixDraft } from './jenkinsFixDraft';
import { jenkinsRebuildDraft } from './jenkinsRebuildDraft';

/** Import this module once (side effect only) to register every known draft kind — see src/interface/server.ts's constructor. */
registerDraftKind(teamsReplyDraft);
registerDraftKind(emailReplyDraft);
registerDraftKind(jiraActionDraft);
registerDraftKind(confluencePageDraft);
registerDraftKind(confluenceDevCycleDraft);
registerDraftKind(gitBranchCreateDraft);
registerDraftKind(devPlanDraft);
registerDraftKind(jiraTransitionDraft);
registerDraftKind(bitbucketPrCommentDraft);
registerDraftKind(prOpenDraft);
registerDraftKind(jenkinsFixDraft);
registerDraftKind(jenkinsRebuildDraft);
