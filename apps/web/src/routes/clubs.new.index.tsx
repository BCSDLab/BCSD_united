import { useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';

import type { NewClubData } from 'api/club/entity';
import AdditionalInfoModal from 'components/Club/NewClubPage/components/AdditionalInfoModal';
import MobileView from 'components/Club/NewClubPage/components/MobileView';
import PCView from 'components/Club/NewClubPage/components/PCView';
import PageLayout from 'components/layout';
import useMediaQuery from 'utils/hooks/layout/useMediaQuery';
import useBooleanState from 'utils/hooks/state/useBooleanState';
import { useUser } from 'utils/hooks/state/useUser';

import styles from 'pages/clubs/new/NewClubPage.module.scss';

function NewClubPage() {
  const { data: userInfo } = useUser();
  const isMobile = useMediaQuery();
  const [formData, setFormData] = useState<NewClubData>({
    name: '',
    image_url: '',
    club_managers: [{ user_id: String(userInfo?.id || 0) }],
    club_category_id: 1,
    location: '',
    description: '',
    role: '',
    is_like_hidden: false,
  });

  const [isModalOpen, openModal, closeModal] = useBooleanState(false);

  return (
    <div className={styles.layout}>
      {isMobile ? (
        <MobileView formData={formData} setFormData={setFormData} openModal={openModal} />
      ) : (
        <PCView formData={formData} setFormData={setFormData} openModal={openModal} />
      )}
      {isModalOpen && <AdditionalInfoModal closeModal={closeModal} formData={formData} setFormData={setFormData} />}
    </div>
  );
}

export default NewClubPage;

export const Route = createFileRoute('/clubs/new/')({
  validateSearch: (search: Record<string, unknown>) => search as Record<string, string | string[] | undefined>,
  component: RouteComponent,
});

function RouteComponent() {
  const page = <NewClubPage />;

  return <PageLayout>{page}</PageLayout>;
}
