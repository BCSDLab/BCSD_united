import { createHash } from 'node:crypto';
import { decodeExtendedJson, parseLossless, signed64, utcTimestamp } from './transform.mjs';
export const ARCHIVED_MONGO_COLLECTIONS = ['bus_timetables', 'shuttlebus_timetables_backup_deployment_20260928'];
export const MONGO_COLLECTIONS = [
  'citybus_timetables',
  'shuttlebus_timetables',
  'lost_item_chat_room',
  'lost_item_chat_user_block',
  'address_byeongcheon',
  ...ARCHIVED_MONGO_COLLECTIONS,
];
const bool = (value) => (value === true || value === 1 || value === '1' || value === 'true' ? 1 : 0);
const number = (value) => {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new TypeError(`Unsafe integer ${value}`);
  return n;
};
const json = (value) => JSON.stringify(value);
const decodeBuffer = (value) =>
  value && typeof value === 'object' && 'base64' in value
    ? new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(value.base64, 'base64'))
    : Array.isArray(value)
      ? value.map(decodeBuffer)
      : value;
const parseValue = (value) => {
  if (typeof value !== 'string') return value;
  try {
    return parseLossless(value);
  } catch {
    return value;
  }
};
const snake = (value) => value.replace(/[A-Z]/g, (letter) => '_' + letter.toLowerCase());
function hashObject(array) {
  const flat = Object.create(null);
  for (let i = 0; i < array.length; i += 2) flat[array[i]] = array[i + 1];
  const nested = Object.create(null);
  for (const [key, value] of Object.entries(flat)) {
    if (key === '_class') continue;
    const parts = key.replace(/\[(\d+)\]/g, '.$1').split('.');
    if (parts.some((part) => ['__proto__', 'prototype', 'constructor'].includes(part)))
      throw new Error('Unsafe Spring Redis field path');
    let target = nested;
    for (let i = 0; i < parts.length - 1; i += 1)
      target = target[parts[i]] ??= /^\d+$/.test(parts[i + 1]) ? [] : Object.create(null);
    target[parts.at(-1)] = value;
  }
  return nested;
}
function javaJson(value) {
  const parsed = parseValue(value);
  if (
    Array.isArray(parsed) &&
    parsed.length === 2 &&
    typeof parsed[0] === 'string' &&
    (parsed[0].includes('.') || parsed[0].startsWith('['))
  )
    return javaJson(parsed[1]);
  if (Array.isArray(parsed)) return parsed.map(javaJson);
  if (parsed && typeof parsed === 'object')
    return Object.fromEntries(
      Object.entries(parsed)
        .filter(([key]) => key !== '@class')
        .map(([key, item]) => [key, javaJson(item)]),
    );
  return parsed;
}
function localDateTime(value) {
  if (!Array.isArray(value)) return String(value);
  if (value.length < 5 || value.length > 7) throw new TypeError('Invalid Jackson LocalDateTime array');
  const [year, month, day, hour, minute, second = 0, nano = 0] = value.map(number);
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}${nano ? '.' + String(nano).padStart(9, '0') : ''}`;
}
const iso = (value, offset) => utcTimestamp(localDateTime(value), offset).replace(' ', 'T') + 'Z';
export function chatRow(value, context) {
  const v = decodeExtendedJson(value);
  return {
    id: signed64(v.id ?? v.tsid),
    article_id: number(v.articleId ?? v.article_id ?? context.articleId),
    chatroom_id: number(v.chatRoomId ?? v.chatroom_id ?? context.chatRoomId),
    user_id: number(v.userId ?? v.user_id),
    is_read: bool(v.isRead ?? v.is_read),
    is_deleted: bool(v.isDeleted ?? v.is_deleted),
    is_image: v.isImage == null && v.is_image == null ? null : bool(v.isImage ?? v.is_image),
    nick_name: v.nickName ?? v.nickname ?? null,
    contents: v.contents ?? null,
    created_at: iso(v.createdAt ?? v.created_at, context.offset),
  };
}
export function mongoRows(collection, source, context) {
  const doc = decodeExtendedJson(source);
  const result = [];
  const add = (table, row) => result.push({ table, row });
  if (collection === 'lost_item_chat_room') {
    add(collection, {
      _id: String(doc._id),
      article_id: number(doc.article_id),
      chatroom_id: number(doc.chatroom_id),
      article_author_id: number(doc.article_author_id),
      item_owner_id: number(doc.item_owner_id),
      created_at: iso(doc.created_at, context.offset),
      messages: json(doc.messages ?? []),
    });
    for (const message of doc.messages ?? [])
      add(
        'native_chat_message',
        chatRow(message, { ...context, articleId: doc.article_id, chatRoomId: doc.chatroom_id }),
      );
  } else if (collection === 'lost_item_chat_user_block') {
    add(collection, {
      _id: String(doc._id),
      blocker_user_id: number(doc.blocker_user_id),
      blocked_user_id: number(doc.blocked_user_id),
      is_active: bool(doc.is_active),
      created_at: iso(doc.created_at, context.offset),
    });
  } else if (collection === 'citybus_timetables') {
    let updated = String(doc.updated_at);
    if (/Z$|[+-]\d\d:\d\d$/.test(updated)) {
      const sign = context.offset.startsWith('-') ? -1 : 1;
      const [hours, minutes] = context.offset.slice(1).split(':').map(Number);
      updated = new Date(Date.parse(updated) + sign * (hours * 60 + minutes) * 60000)
        .toISOString()
        .slice(0, 19)
        .replace('T', ' ');
    }
    add(collection, {
      id: String(doc._id),
      bus_info: json(doc.bus_info),
      bus_timetables: json(doc.bus_timetables),
      updated_at: updated.replace('T', ' '),
    });
  } else if (collection === 'shuttlebus_timetables') {
    add(collection, {
      id: String(doc._id),
      semester_type: doc.semester_type,
      region: doc.region,
      route_type: doc.route_type,
      route_name: doc.route_name,
      sub_name: doc.sub_name ?? null,
      node_info: json(doc.node_info),
      route_info: json(doc.route_info),
    });
  } else if (collection === 'address_byeongcheon') {
    add(collection, {
      id: String(doc._id),
      ...Object.fromEntries(
        [
          'road_address',
          'jibun_address',
          'eng_address',
          'zip_no',
          'bd_nm',
          'si_nm',
          'sgg_nm',
          'emd_nm',
          'li_nm',
          'rn',
        ].map((key) => [key, doc[key] ?? null]),
      ),
    });
  } else if (!ARCHIVED_MONGO_COLLECTIONS.includes(collection))
    throw new Error(`Unmapped Mongo collection ${collection}`);
  if (doc._id === undefined || doc._id === null)
    throw new Error(`Mongo document has no source identity: ${collection}`);
  add('native_legacy_mongo', { collection, source_id: String(doc._id), payload: json(source) });
  return result;
}

function paymentSnapshot(v, context) {
  const db = context.db;
  const cart = db
    .prepare(
      `SELECT c.*,os.shop_id,os.delivery,os.takeout,os.minimum_order_amount,s.name AS shop_name,s.address AS shop_address,s.address_detail AS shop_address_detail,(SELECT image_url FROM orderable_shop_image WHERE orderable_shop_id=os.id AND is_thumbnail=1 AND is_deleted=0 LIMIT 1) AS thumbnail FROM cart c JOIN orderable_shop os ON os.id=c.orderable_shop_id JOIN shops s ON s.id=os.shop_id WHERE c.user_id=?`,
    )
    .get(number(v.userId));
  if (!cart || cart.orderable_shop_id !== number(v.orderableShopId))
    throw new Error(`Temporary payment ${v.pgOrderId} has no matching current cart`);
  cart.revision = 0;
  cart.items = db
    .prepare(
      `SELECT ci.*,m.name,p.name AS price_name,p.price,(SELECT image_url FROM orderable_shop_menu_images WHERE orderable_shop_menu_id=m.id AND is_thumbnail=1 AND is_deleted=0 LIMIT 1) AS thumbnail FROM cart_menu_item ci JOIN orderable_shop_menu m ON m.id=ci.orderable_shop_menu_id JOIN orderable_shop_menu_price p ON p.id=ci.orderable_shop_menu_price_id WHERE ci.cart_id=? ORDER BY ci.id`,
    )
    .all(cart.id);
  const options = db
    .prepare(
      `SELECT co.*,og.id AS option_group_id,og.name AS option_group_name FROM cart_menu_item_option co JOIN cart_menu_item ci ON ci.id=co.cart_menu_item_id JOIN orderable_shop_menu_option mo ON mo.id=co.orderable_shop_menu_option_id JOIN orderable_shop_menu_option_group og ON og.id=mo.orderable_shop_menu_option_group_id WHERE ci.cart_id=? ORDER BY co.id`,
    )
    .all(cart.id);
  for (const item of cart.items) item.options = options.filter((option) => option.cart_menu_item_id === item.id);
  const itemsAmount = cart.items.reduce(
    (sum, item) =>
      sum +
      (item.price + item.options.reduce((subtotal, option) => subtotal + option.option_price * option.quantity, 0)) *
        item.quantity,
    0,
  );
  if (
    !cart.items.length ||
    itemsAmount !== number(v.totalProductPrice) ||
    itemsAmount + number(v.deliveryFee) !== number(v.totalPrice)
  )
    throw new Error(`Temporary payment ${v.pgOrderId} cart amount differs; reconcile before cutover`);
  const request = Object.fromEntries(
    ['phoneNumber', 'address', 'addressDetail', 'longitude', 'latitude', 'toOwner', 'toRider', 'provideCutlery'].map(
      (key) => [snake(key), v[key] ?? null],
    ),
  );
  return {
    cart,
    request,
    amounts: { itemsAmount, deliveryFee: number(v.deliveryFee), totalAmount: number(v.totalPrice) },
  };
}

export function redisRows(record, context) {
  const key = record.key;
  const archive = (disposition) => ({
    disposition,
    rows: [
      {
        table: 'native_legacy_redis',
        row: { key, type: record.type, payload: json(record.value), expires_at: record.expiresAt, disposition },
      },
    ],
  });
  if (record.expiresAt !== null && record.expiresAt <= context.now) return archive('expired-archived');
  const springKey =
    /^(AbtestVariableCount|AbtestVariableAssign|articleHitUser|articleHit|HotArticleKeyword|ClubCreateRequest|hotClub|Weather|CityBus|CityBusRoute|expressBus|busNoticeArticle|refreshToken|userVerificationStatus|userDailyVerificationCount|StudentTemporaryStatus|passwordResetToken|owner_shop@|dailyVerifyCount@|verificationStatus@|TemporaryPayment@|excelDownload|diningSoldOut|DiningNotify)(?::.*)?$/;
  if (springKey.test(key) && (record.type === 'set' || key.endsWith(':phantom')))
    return archive('spring-secondary-index-archived');
  if (
    key.startsWith('SocketSessionUserId:') ||
    key.startsWith('DiningNotify:') ||
    key === 'Shops' ||
    /^[0-9a-f]{64}$/.test(key)
  )
    return archive('non-authoritative-cache-archived');
  const decoded = decodeBuffer(record.value);
  const value =
    record.type === 'hash'
      ? key.startsWith('search:count:ip:')
        ? Object.fromEntries(
            Array.from({ length: decoded.length / 2 }, (_, index) => [
              decoded[index * 2],
              parseValue(decoded[index * 2 + 1]),
            ]),
          )
        : hashObject(decoded)
      : javaJson(decoded);
  const rows = [];
  const add = (table, row) => rows.push({ table, row });
  const expiry = record.expiresAt;
  const requireExpiry = () => {
    if (!Number.isSafeInteger(expiry)) throw new Error(`Missing Redis TTL for ${key}`);
    return expiry;
  };
  const suffix = (prefix) => key.slice(prefix.length);
  const token = (id, kind, target, payload, userId = null) =>
    add('identity_tokens', {
      id,
      kind,
      target: String(target),
      user_id: userId,
      payload: json(payload),
      expires_at: requireExpiry(),
    });
  const zset = () => {
    const pairs = [];
    for (let i = 0; i < decoded.length; i += 2) pairs.push([javaJson(decoded[i]), Number(decoded[i + 1])]);
    return pairs;
  };
  let disposition = 'mapped';
  if (key.startsWith('webAuthSession:'))
    add('identity_web_sessions', {
      id: value.id,
      user_id: number(value.userId),
      refresh_token_hash: value.refreshTokenHash,
      csrf_token: value.csrfToken,
      credential_hash: value.credentialHash,
      expires_at: Date.parse(value.expiresAt),
      auto_login: bool(value.autoLogin),
    });
  else if (key.startsWith('refreshToken:') && record.type === 'hash') {
    const id = String(value.id ?? suffix('refreshToken:'));
    const [user, platform] = id.split(':');
    add('identity_native_sessions', {
      id,
      user_id: number(user),
      platform,
      token: value.token,
      expires_at: requireExpiry(),
    });
  } else if (key.startsWith('userVerificationStatus:') && record.type === 'hash') {
    const id = String(value.id ?? suffix('userVerificationStatus:'));
    add('identity_verifications', {
      id,
      target: id,
      channel: id.includes('@') ? 'EMAIL' : 'SMS',
      code: String(value.verificationCode),
      trial_count: number(value.trialCount ?? 0),
      verified: bool(value.isVerified),
      expires_at: requireExpiry(),
    });
  } else if (key.startsWith('userDailyVerificationCount:') && record.type === 'hash')
    add('identity_verification_limits', {
      id: String(value.id ?? suffix('userDailyVerificationCount:')),
      send_count: number(value.verificationCount),
      verify_count: 0,
      expires_at: requireExpiry(),
    });
  else if (key.startsWith('owner_shop@:') && record.type === 'hash')
    token(
      'owner_shop:' + value.ownerId,
      'owner_shop',
      value.ownerId,
      {
        shop_id: value.shopId == null ? null : number(value.shopId),
        shop_name: value.shopName,
        shop_number: value.shopNumber,
      },
      number(value.ownerId),
    );
  else if (key.startsWith('dailyVerifyCount@:') && record.type === 'hash') {
    const phone = value.key ?? suffix('dailyVerifyCount@:');
    token('owner_sms_daily:' + phone, 'owner_sms_daily', phone, number(value.requestCount));
  } else if (key.startsWith('verificationStatus@:') && record.type === 'hash') {
    const phone = value.key ?? suffix('verificationStatus@:');
    token('owner_sms:' + phone, 'owner_sms', phone, { code: String(value.certificationCode) });
  } else if (key.startsWith('StudentTemporaryStatus:') && record.type === 'hash') {
    const email = value.email ?? suffix('StudentTemporaryStatus:');
    const gender =
      value.gender == null ? null : value.gender === 'MAN' ? 0 : value.gender === 'WOMAN' ? 1 : number(value.gender);
    token('student_signup:' + email, 'student_signup', email, {
      email,
      name: value.name,
      password: value.password,
      nickname: value.nickname,
      gender,
      is_graduated: Boolean(bool(value.isGraduated)),
      major: value.department,
      student_number: value.studentNumber,
      phone_number: value.phoneNumber,
      token: value.authToken,
    });
  } else if (key.startsWith('passwordResetToken:') && record.type === 'hash') {
    const userId = number(value.id ?? value.userId ?? suffix('passwordResetToken:'));
    const user = context.db.prepare('SELECT email FROM users WHERE id=?').get(userId);
    if (!user) throw new Error(`Reset token references missing user ${userId}`);
    token('student_reset:' + userId, 'student_reset', user.email, { token: value.token ?? value.resetToken }, userId);
  } else if (/^article:\d+:chatroom:\d+:message$/.test(key)) {
    const [, articleId, , chatRoomId] = key.split(':');
    for (const [entry] of zset()) {
      if (typeof entry !== 'string' || !entry.includes('|')) throw new Error(`Invalid chat ZSET encoding ${key}`);
      add(
        'native_chat_message',
        chatRow(parseLossless(entry.slice(entry.indexOf('|') + 1)), { ...context, articleId, chatRoomId }),
      );
    }
  } else if (/^chat:article:\d+:room:\d+:user:\d+$/.test(key)) {
    const parts = key.split(':');
    add('native_chat_polling_session', {
      article_id: number(parts[2]),
      chatroom_id: number(parts[4]),
      user_id: number(parts[6]),
      expires_at: requireExpiry(),
    });
  } else if (key.startsWith('AbtestVariableCount:') && record.type === 'hash')
    add('abtest_variable_count', {
      variable_id: number(value.variableId ?? suffix('AbtestVariableCount:')),
      count: number(value.count),
    });
  else if (key.startsWith('AbtestVariableAssign:') && record.type === 'hash') {
    const [variable, history] = String(value.id ?? suffix('AbtestVariableAssign:')).split(':');
    add('abtest_variable_assign', {
      variable_id: number(variable),
      access_history_id: number(history),
      expires_at: requireExpiry(),
    });
  } else if (key.startsWith('articleHitUser:') && record.type === 'hash') {
    const id = String(value.id ?? suffix('articleHitUser:'));
    const split = id.indexOf(':');
    add('native_article_hit_user', {
      article_id: number(id.slice(0, split)),
      public_ip: id.slice(split + 1),
      expires_at: requireExpiry(),
    });
  } else if (key.startsWith('articleHit:') && record.type === 'hash')
    add('native_article_hit_snapshot', {
      article_id: number(value.id ?? suffix('articleHit:')),
      hit: number(value.hit),
    });
  else if (key === 'hotArticles')
    decoded.forEach((id, index) => add('native_hot_article', { article_id: number(javaJson(id)), score: -index }));
  else if (key === 'popular_keywords')
    for (const [keyword, weight] of zset()) add('native_popular_keyword', { keyword: String(keyword), weight });
  else if (key.startsWith('search:count:ip:'))
    for (const [keyword, count] of Object.entries(value))
      add('native_article_search_count', { public_ip: suffix('search:count:ip:'), keyword, count: number(count) });
  else if (key.startsWith('HotArticleKeyword:') && record.type === 'hash')
    add('native_article_keyword_suggestion', {
      keyword_id: number(value.hotKeywordId ?? suffix('HotArticleKeyword:')),
      keyword: value.keyword,
      category: value.category,
      count: number(value.count),
    });
  else if (key.startsWith('club:hits:'))
    add('native_club_hits', { club_id: number(suffix('club:hits:')), hits: number(value) });
  else if (key === 'hotClub:hot_club')
    add('native_club_hot', {
      key: 'hot',
      payload: json({ club_id: number(value.clubId), name: value.name, image_url: value.imageUrl }),
    });
  else if (key.startsWith('ClubCreateRequest:') && record.type === 'hash') {
    const payload = {
      ...Object.fromEntries(
        [
          'name',
          'imageUrl',
          'location',
          'description',
          'instagram',
          'googleForm',
          'openChat',
          'phoneNumber',
          'role',
        ].map((name) => [snake(name), value[name] ?? null]),
      ),
      club_managers: (value.clubAdmins ?? []).map((manager) => ({
        user_id: number(manager.userId ?? manager.user_id),
      })),
      club_category_id: number(value.clubCategoryId),
      is_like_hidden: value.isLikeHidden == null ? null : Boolean(bool(value.isLikeHidden)),
    };
    add('native_club_requests', {
      name: value.name ?? suffix('ClubCreateRequest:'),
      payload: json(payload),
      requester_id: number(value.requesterId),
      created_at: utcTimestamp(localDateTime(value.createdAt), context.offset),
      expires_at: utcTimestamp(new Date(requireExpiry()).toISOString()),
    });
  } else if (key === 'callvan:notification:queue')
    for (const [event, score] of zset()) {
      if (event.type !== 'DEPARTURE_UPCOMING') throw new Error(`Unsupported callvan notification ${event.type}`);
      add('native_callvan_event', {
        id: 'callvan:reminder:' + event.postId,
        post_id: number(event.postId),
        type: event.type,
        payload: '{}',
        available_at: utcTimestamp(new Date(score * 1000).toISOString()),
        completed_at: null,
        created_at: utcTimestamp(new Date(context.now).toISOString()),
      });
    }
  else if (key === 'ShopReviewNotifications')
    for (const [event, score] of zset())
      add('native_catalog_outbox', {
        id: `review-prompt:${event.studentId}:${event.shopId}`,
        kind: 'commerce.catalog.review-prompt',
        payload: json({ shopId: number(event.shopId), userId: number(event.studentId) }),
        due_at: (score - 32400) * 1000,
        delivered_at: null,
      });
  else if (key.startsWith('TemporaryPayment@:') && record.type === 'hash') {
    const snapshot = paymentSnapshot(value, context);
    add('temporary_payment', {
      pg_order_id: String(value.pgOrderId ?? suffix('TemporaryPayment@:')),
      user_id: number(value.userId),
      orderable_shop_id: number(value.orderableShopId),
      order_type: value.orderType,
      snapshot_json: json(snapshot),
      total_price: number(value.totalPrice),
      status: 'PREPARED',
      payment_key: null,
      idempotency_key: createHash('sha256')
        .update('import:' + key)
        .digest('hex'),
      created_at: iso(value.createdAt, context.offset),
      expires_at: requireExpiry(),
      claimed_until: null,
      next_attempt_at: null,
      attempts: 0,
      gateway_json: null,
      last_error: null,
      completed_order_id: null,
    });
  } else if ((key.startsWith('excelDownload:') || key.startsWith('diningSoldOut:')) && record.type === 'hash') {
    const excel = key.startsWith('excelDownload:');
    add('native_dining_rate_limit', {
      key: (excel ? 'excel:' : 'soldout:') + (value.id ?? key.slice(key.indexOf(':') + 1)),
      expires_at: new Date(requireExpiry()).toISOString(),
    });
  } else if (/^(Weather|CityBus|CityBusRoute|expressBus|busNoticeArticle):/.test(key) && record.type === 'hash') {
    const prefix = key.slice(0, key.indexOf(':'));
    let id = key;
    let payload;
    if (prefix === 'Weather')
      payload = Object.fromEntries(
        Object.entries(value.hourlyWeathers ?? {}).map(([hour, weather]) => [
          hour,
          {
            temperature: number(weather.temperature),
            weather: weather.weather,
            weather_id: number(weather.weatherId ?? weather.weather_id),
            weather_icon_url: weather.weatherIconUrl ?? weather.weather_icon_url,
          },
        ]),
      );
    if (prefix === 'CityBus')
      payload = (value.busInfos ?? []).map((bus) => {
        const [h, m, s = 0] = (Array.isArray(bus.remainTime) ? bus.remainTime : String(bus.remainTime).split(':')).map(
          Number,
        );
        return { bus_number: number(bus.busNumber), arrival_seconds: h * 3600 + m * 60 + s };
      });
    if (prefix === 'CityBusRoute') payload = (value.busNumbers ?? []).map(number);
    if (prefix === 'expressBus') {
      id = key.toLowerCase().replace(/^expressbus:/, 'expressBus:');
      const time = (value) =>
        Array.isArray(value)
          ? value
              .slice(0, 2)
              .map((part) => String(part).padStart(2, '0'))
              .join(':')
          : String(value).slice(0, 5);
      payload = (value.busInfos ?? []).map((bus) => ({
        depart: time(bus.depart),
        arrival: time(bus.arrival),
        charge: number(bus.charge),
      }));
    }
    if (prefix === 'busNoticeArticle') {
      id = 'busNoticeArticle';
      payload = { id: number(value.id), title: value.title };
    }
    if (payload === undefined) throw new Error(`Unrecognized transport cache shape ${key}`);
    add('native_transport_cache', { id, payload: json(payload), expires_at: expiry, updated_at: record.capturedAt });
  } else
    throw new Error(
      `Unmapped live Redis key ${key} (${record.type}); add an explicit reviewed adapter, never discard it`,
    );
  add('native_legacy_redis', { key, type: record.type, payload: json(record.value), expires_at: expiry, disposition });
  return { rows, disposition };
}
