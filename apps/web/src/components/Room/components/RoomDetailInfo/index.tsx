interface RoomDetailInfoProps {
  size: string | null;
  roomType: string | null;
}

export default function RoomDetailInfo({ size, roomType }: RoomDetailInfoProps) {
  return (
    <dl>
      <dt>월세 | 전세</dt>
      <dd>별도 문의</dd>
      <dt>보증금 | 관리비</dt>
      <dd>별도 문의</dd>
      <dt>방크기</dt>
      <dd>{size ? `${size}평` : '-'}</dd>
      <dt>방종류</dt>
      <dd>{roomType || '-'}</dd>
    </dl>
  );
}
