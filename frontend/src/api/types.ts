export interface MenuItem {
  allergens: string[];
  currency: string;
  description: string | null;
  display_order: number;
  id: string;
  image_url: string | null;
  is_available: boolean;
  name: string;
  price_amount: number;
}

export interface MenuCategory {
  description: string | null;
  display_order: number;
  id: string;
  items: MenuItem[];
  name: string;
}

export interface MenuResponse {
  categories: MenuCategory[];
}

export interface QuoteItemRequest {
  menu_item_id: string;
  quantity: number;
}

export interface QuoteRequest {
  items: QuoteItemRequest[];
}

export interface QuoteLine {
  line_total_amount: number;
  menu_item_id: string;
  name: string;
  quantity: number;
  unit_price_amount: number;
}

export interface QuoteResponse {
  currency: string;
  items: QuoteLine[];
  subtotal_amount: number;
  total_amount: number;
}

export type OrderType = 'dine_in' | 'takeaway';

export type OrderStatus =
  'accepted' | 'cancelled' | 'completed' | 'created' | 'preparing' | 'ready';

export type OrderCreateRequest =
  | {
      items: QuoteItemRequest[];
      order_type: 'takeaway';
    }
  | {
      items: QuoteItemRequest[];
      order_type: 'dine_in';
      table_number: number;
    };

export interface OrderCreateItemResponse {
  line_total_amount: number;
  menu_item_id: string;
  name: string;
  quantity: number;
  unit_price_amount: number;
}

export interface OrderCreateResponse {
  currency: string;
  items: OrderCreateItemResponse[];
  order_access_token: string;
  order_type: OrderType;
  public_order_number: string;
  status: OrderStatus;
  subtotal_amount: number;
  table_number: number | null;
  total_amount: number;
}

export interface OrderStatusResponse {
  created_at: string;
  currency: string;
  items: OrderCreateItemResponse[];
  order_type: OrderType;
  public_order_number: string;
  status: OrderStatus;
  subtotal_amount: number;
  table_number: number | null;
  total_amount: number;
  updated_at: string;
}

export type PaymentStatus = 'expired' | 'failed' | 'pending' | 'succeeded';

export interface CheckoutSessionResponse {
  checkout_url: string;
  expires_at: string;
  payment_status: PaymentStatus;
  public_order_number: string;
}
