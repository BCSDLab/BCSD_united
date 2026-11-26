import type { APIResponse } from 'interfaces/APIResponse';

export interface LandList {
  internal_name: string;
  monthly_fee: string | null;
  latitude: number | null;
  longitude: number | null;
  charter_fee: string | null;
  name: string;
  id: number;
  room_type: string | null;
  address: string | null;
  is_monthly_available: boolean;
  is_charter_available: boolean;
}

export interface LandDetailResponse extends APIResponse {
  monthly_fee: string | null;
  latitude: number | null;
  longitude: number | null;
  charter_fee: string | null;
  created_at: string;
  description: string | null;
  image_urls: null | string[];
  internal_name: string;
  is_deleted: boolean;
  updated_at: string;
  id: number;
  floor: null | number;
  management_fee: string | null;
  address: string | null;
  size: string | null;
  phone: string | null;
  name: string;
  deposit: string | null;
  permalink: string;
  room_type: string | null;
  opt_electronic_door_locks: boolean;
  opt_tv: boolean;
  opt_elevator: boolean;
  opt_water_purifier: boolean;
  opt_washer: boolean;
  opt_veranda: boolean;
  opt_gas_range: boolean;
  opt_induction: boolean;
  opt_bidet: boolean;
  opt_shoe_closet: boolean;
  opt_refrigerator: boolean;
  opt_desk: boolean;
  opt_closet: boolean;
  opt_air_conditioner: boolean;
  opt_bed: boolean;
  opt_microwave: boolean;
}
export interface LandListResponse extends APIResponse {
  lands: LandList[];
}
