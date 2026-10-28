import { createFileRoute, useSearch, useParams } from '@tanstack/react-router';
import PageLayout from 'components/layout';
import { useRef, useState } from 'react';


import type { NewClubData } from 'api/club/entity';
import useClubDetail from 'components/Club/ClubDetailPage/hooks/useClubdetail';
import EditConfirmModal from 'components/Club/ClubEditPage/components/EditConfirmModal';
import MobileView from 'components/Club/NewClubPage/components/MobileView';
import PCView from 'components/Club/NewClubPage/components/PCView';
import useMediaQuery from 'utils/hooks/layout/useMediaQuery';
import useBooleanState from 'utils/hooks/state/useBooleanState';
import { mapDetailToForm } from 'utils/ts/clubCategoryMapping';

import styles from 'pages/clubs/edit/ClubEditPage.module.scss';

function ClubEditPage({ id }: { id: number }) {
  const { clubDetail } = useClubDetail(id);

  const isMobile = useMediaQuery();

  const initForm = () => {
    const mapped = mapDetailToForm(clubDetail);

    return {
      ...mapped,
      open_chat: mapped.open_chat?.replace(/^https?:\/\//, '') ?? '',
    };
  };

  const originalDataRef = useRef<NewClubData>(initForm());
  const [formData, setFormData] = useState<NewClubData>(initForm);

  const resetForm = () => setFormData(originalDataRef.current);

  const [isModalOpen, openModal, closeModal] = useBooleanState(false);
  const [type, setType] = useState('');

  return (
    <div className={styles.layout}>
      {isMobile ? (
        <MobileView formData={formData} setFormData={setFormData} openModal={openModal} isEdit setType={setType} />
      ) : (
        <PCView formData={formData} setFormData={setFormData} openModal={openModal} isEdit setType={setType} />
      )}

      {isModalOpen && (
        <EditConfirmModal closeModal={closeModal} formData={formData} resetForm={resetForm} type={type} id={id} />
      )}
    </div>
  );
}

export default function ClubEditPageWrapper() {
  
  
  const routeQuery: Record<string, string | string[] | undefined> = { ...useSearch({ strict: false }), ...useParams({ strict: false }) };
  
  const { id } = routeQuery;

  if (typeof id !== 'string') {
    return null;
  }

  return <ClubEditPage id={Number(id)} />;
}

export const Route = createFileRoute('/clubs/edit/$id/')({
  validateSearch: (search: Record<string, unknown>) => search as Record<string, string | string[] | undefined>,
  component: RouteComponent,
});

function RouteComponent() {
  const page = <ClubEditPageWrapper />;
  return <PageLayout>{page}</PageLayout>;
}
