/** Tipos de la Graph API de Instagram (solo los campos que usamos). */

export interface IgMe {
  id?: string;
  user_id: string;
  username: string;
}

export interface IgMedia {
  id: string;
  caption?: string;
  permalink?: string;
  shortcode?: string;
  timestamp?: string;
  media_type?: string;
  owner?: { id: string };
  username?: string;
  /** Comentarios del vídeo según Instagram (incluye las respuestas en hilos). */
  comments_count?: number;
  /** Me gusta (solo se pide en el radar de otras cuentas). */
  like_count?: number;
}

/** Datos públicos de otra cuenta profesional (Business Discovery), para el radar. */
export interface IgBusinessDiscovery {
  username: string;
  name?: string;
  followers_count?: number;
  media_count?: number;
  media?: IgPage<IgMedia>;
}

export interface IgComment {
  id: string;
  text?: string;
  timestamp?: string;
  username?: string;
  from?: { id?: string; username?: string };
  parent_id?: string;
  hidden?: boolean;
  media?: { id: string };
  /** Me gusta del comentario (solo se pide al contar votos). */
  like_count?: number;
  replies?: IgPage<IgComment>;
}

export interface IgPage<T> {
  data: T[];
  paging?: {
    cursors?: { before?: string; after?: string };
    next?: string;
  };
}

/** Un comentario principal con todas sus respuestas (para la importación). */
export interface IgThread {
  comment: IgComment;
  replies: IgComment[];
}
