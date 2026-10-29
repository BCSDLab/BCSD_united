export const collationPolicies: Record<
  string,
  { name: string; columns: { name: string; collation: string | null }[] }[]
> = {
  abtest: [
    {
      name: 'title_UNIQUE',
      columns: [
        {
          name: 'title',
          collation: 'utf8mb4_0900_ai_ci',
        },
      ],
    },
  ],
  academic_program_year: [
    {
      name: 'ux_academic_program_year',
      columns: [
        {
          name: 'student_year',
          collation: 'utf8mb4_0900_ai_ci',
        },
        {
          name: 'department_id',
          collation: null,
        },
        {
          name: 'major_key',
          collation: null,
        },
      ],
    },
  ],
  admins: [
    {
      name: 'uq_admin_email',
      columns: [
        {
          name: 'email',
          collation: 'utf8mb4_0900_ai_ci',
        },
      ],
    },
    {
      name: 'uq_admin_login_id',
      columns: [
        {
          name: 'login_id',
          collation: 'utf8mb4_0900_ai_ci',
        },
      ],
    },
  ],
  article_keywords: [
    {
      name: 'uk_article_keywords_keyword_category',
      columns: [
        {
          name: 'keyword',
          collation: 'utf8mb4_0900_ai_ci',
        },
        {
          name: 'category',
          collation: 'utf8mb4_0900_ai_ci',
        },
      ],
    },
  ],
  article_search_keyword_ip_map: [
    {
      name: 'unique_keyword_ip',
      columns: [
        {
          name: 'keyword_id',
          collation: null,
        },
        {
          name: 'ip_address',
          collation: 'utf8mb4_0900_ai_ci',
        },
      ],
    },
  ],
  article_search_keywords: [
    {
      name: 'keyword',
      columns: [
        {
          name: 'keyword',
          collation: 'utf8mb4_0900_ai_ci',
        },
      ],
    },
  ],
  coop_semester: [
    {
      name: 'semester',
      columns: [
        {
          name: 'semester',
          collation: 'utf8mb4_0900_ai_ci',
        },
      ],
    },
  ],
  department_contact_departments: [
    {
      name: 'uk_department_contact_departments_category_name',
      columns: [
        {
          name: 'category',
          collation: 'utf8mb4_0900_ai_ci',
        },
        {
          name: 'name',
          collation: 'utf8mb4_0900_ai_ci',
        },
      ],
    },
  ],
  dining_menus: [
    {
      name: 'ux_date_type_place',
      columns: [
        {
          name: 'date',
          collation: null,
        },
        {
          name: 'type',
          collation: 'utf8mb3_unicode_ci',
        },
        {
          name: 'place',
          collation: 'utf8mb3_unicode_ci',
        },
      ],
    },
  ],
  lands: [
    {
      name: 'ux_name',
      columns: [
        {
          name: 'name',
          collation: 'utf8mb3_unicode_ci',
        },
      ],
    },
  ],
  major: [
    {
      name: 'unique_name_department',
      columns: [
        {
          name: 'name',
          collation: 'utf8mb4_0900_ai_ci',
        },
        {
          name: 'department_id',
          collation: null,
        },
      ],
    },
  ],
  notification_subscribe: [
    {
      name: 'unique_user_id_subscribe_type_detail_type',
      columns: [
        {
          name: 'user_id',
          collation: null,
        },
        {
          name: 'subscribe_type',
          collation: 'utf8mb4_0900_ai_ci',
        },
        {
          name: 'detail_type',
          collation: 'utf8mb4_0900_ai_ci',
        },
      ],
    },
  ],
  order: [
    {
      name: 'PRIMARY',
      columns: [
        {
          name: 'id',
          collation: 'utf8mb4_0900_ai_ci',
        },
      ],
    },
  ],
  order_delivery: [
    {
      name: 'PRIMARY',
      columns: [
        {
          name: 'order_id',
          collation: 'utf8mb4_0900_ai_ci',
        },
      ],
    },
  ],
  order_takeout: [
    {
      name: 'PRIMARY',
      columns: [
        {
          name: 'order_id',
          collation: 'utf8mb4_0900_ai_ci',
        },
      ],
    },
  ],
  order_v2: [
    {
      name: 'uk_order_v2_order_number',
      columns: [
        {
          name: 'order_number',
          collation: 'utf8mb4_0900_ai_ci',
        },
      ],
    },
  ],
  owners: [
    {
      name: 'company_registration_number_UNIQUE',
      columns: [
        {
          name: 'company_registration_number',
          collation: 'utf8mb3_general_ci',
        },
      ],
    },
  ],
  team_recruitment_chat_room: [
    {
      name: 'uk_team_recruitment_chat_room_recruitment_application_type',
      columns: [
        {
          name: 'recruitment_id',
          collation: null,
        },
        {
          name: 'application_id',
          collation: null,
        },
        {
          name: 'room_type',
          collation: 'utf8mb4_0900_ai_ci',
        },
      ],
    },
    {
      name: 'uk_team_recruitment_chat_room_recruitment_scope',
      columns: [
        {
          name: 'recruitment_id',
          collation: null,
        },
        {
          name: 'room_scope_key',
          collation: 'utf8mb4_0900_ai_ci',
        },
      ],
    },
  ],
  team_recruitment_outbox_event: [
    {
      name: 'uk_team_recruitment_outbox_event_key',
      columns: [
        {
          name: 'event_key',
          collation: 'utf8mb4_0900_ai_ci',
        },
      ],
    },
  ],
  team_recruitment_role: [
    {
      name: 'uk_team_recruitment_role_recruitment_name',
      columns: [
        {
          name: 'recruitment_id',
          collation: null,
        },
        {
          name: 'name',
          collation: 'utf8mb4_0900_ai_ci',
        },
      ],
    },
  ],
  users: [
    {
      name: 'anonymous_nickname',
      columns: [
        {
          name: 'anonymous_nickname',
          collation: 'utf8mb4_unicode_ci',
        },
      ],
    },
    {
      name: 'anonymous_nickname_2',
      columns: [
        {
          name: 'anonymous_nickname',
          collation: 'utf8mb4_unicode_ci',
        },
      ],
    },
    {
      name: 'nickname_UNIQUE',
      columns: [
        {
          name: 'nickname',
          collation: 'utf8mb4_unicode_ci',
        },
      ],
    },
    {
      name: 'uq_users_email',
      columns: [
        {
          name: 'email',
          collation: 'utf8mb4_unicode_ci',
        },
      ],
    },
    {
      name: 'uq_users_login_id',
      columns: [
        {
          name: 'user_id',
          collation: 'utf8mb4_unicode_ci',
        },
      ],
    },
    {
      name: 'uq_users_nickname',
      columns: [
        {
          name: 'nickname',
          collation: 'utf8mb4_unicode_ci',
        },
      ],
    },
    {
      name: 'uq_users_phone_number',
      columns: [
        {
          name: 'phone_number',
          collation: 'utf8mb4_unicode_ci',
        },
      ],
    },
  ],
};
