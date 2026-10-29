import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';

import { teamRecruitmentFormSchema, type TeamRecruitmentFormValues } from 'components/Team/NewTeamRecruitment/schema';
import { useServerCalendarDate } from 'utils/ssr/useServerNow';

function createInitialTeamRecruitmentForm(now: Date): TeamRecruitmentFormValues {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);

  return {
    category: null,
    title: '',
    progressType: 'ONLINE',
    activityStartDate: today,
    activityEndDate: tomorrow,
    deadlineDate: new Date(today),
    isRoleUnified: false,
    roles: [],
    unifiedMemberCount: 1,
    description: '',
    relatedUrl: '',
    qualification: '',
  };
}

export default function useTeamRecruitmentForm(defaultValues?: TeamRecruitmentFormValues) {
  const serverNow = useServerCalendarDate();

  return useForm<TeamRecruitmentFormValues>({
    resolver: zodResolver(teamRecruitmentFormSchema),
    mode: 'onChange',
    defaultValues: defaultValues ?? createInitialTeamRecruitmentForm(serverNow),
  });
}
