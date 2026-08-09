import { MeetingType } from '../meetingTypes';
import { WorkflowContext, WorkflowResult } from './types';
import * as standup from './standup';
import * as sprintPlanning from './sprintPlanning';
import * as sprintReview from './sprintReview';
import * as retro from './retro';
import * as oneOnOne from './oneOnOne';
import * as designDev from './designDev';
import * as generic from './generic';

const WORKFLOWS: Record<MeetingType, (ctx: WorkflowContext) => Promise<WorkflowResult>> = {
  standup: standup.gather,
  sprint_planning: sprintPlanning.gather,
  sprint_review: sprintReview.gather,
  retro: retro.gather,
  one_on_one: oneOnOne.gather,
  design_dev: designDev.gather,
  generic: generic.gather,
};

export function getWorkflow(meetingType: MeetingType) {
  return WORKFLOWS[meetingType] || WORKFLOWS.generic;
}
