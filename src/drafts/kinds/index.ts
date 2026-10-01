import { registerDraftKind } from '../registry';
import { teamsReplyDraft } from './teamsReplyDraft';
import { emailReplyDraft } from './emailReplyDraft';
import { jiraActionDraft } from './jiraActionDraft';
import { confluencePageDraft } from './confluencePageDraft';
import { confluenceDevCycleDraft } from './confluenceDevCycleDraft';
import { jiraTransitionDraft } from './jiraTransitionDraft';
import { bitbucketPrCommentDraft } from './bitbucketPrCommentDraft';
import { prReviewDecisionDraft } from './prReviewDecisionDraft';
import { prOpenDraft } from './prOpenDraft';
import { jenkinsFixDraft } from './jenkinsFixDraft';
import { jenkinsRebuildDraft } from './jenkinsRebuildDraft';
import { jiraCommentReplyDraft } from './jiraCommentReplyDraft';
import { bitbucketPrCommentReplyDraft } from './bitbucketPrCommentReplyDraft';

/** Import this module once (side effect only) to register every known draft kind — see src/interface/server.ts's constructor. */
registerDraftKind(teamsReplyDraft);
registerDraftKind(emailReplyDraft);
registerDraftKind(jiraActionDraft);
registerDraftKind(confluencePageDraft);
registerDraftKind(confluenceDevCycleDraft);
registerDraftKind(jiraTransitionDraft);
registerDraftKind(bitbucketPrCommentDraft);
registerDraftKind(prReviewDecisionDraft);
registerDraftKind(prOpenDraft);
registerDraftKind(jenkinsFixDraft);
registerDraftKind(jenkinsRebuildDraft);
registerDraftKind(jiraCommentReplyDraft);
registerDraftKind(bitbucketPrCommentReplyDraft);
