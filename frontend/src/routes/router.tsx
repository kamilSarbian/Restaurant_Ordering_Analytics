import { createBrowserRouter, type RouteObject } from 'react-router-dom';

import App from '../App';
import AppShell from '../components/AppShell';
import CartPage from '../features/cart/CartPage';
import { CartProvider } from '../features/cart/CartContext';
import CheckoutPage from '../features/checkout/CheckoutPage';
import CheckoutCancelledPage from '../features/checkout/CheckoutCancelledPage';
import PaymentReturnPage from '../features/checkout/PaymentReturnPage';
import OrderStatusPage from '../features/order-status/OrderStatusPage';
import NotFoundPage from './NotFoundPage';

export const routes: RouteObject[] = [
  {
    path: '/',
    element: (
      <CartProvider>
        <AppShell />
      </CartProvider>
    ),
    children: [
      {
        index: true,
        element: <App />,
      },
      {
        path: 'cart',
        element: <CartPage />,
      },
      {
        path: 'orders/:publicOrderNumber/checkout',
        element: <CheckoutPage />,
      },
      {
        path: 'orders/:publicOrderNumber/payment-return',
        element: <PaymentReturnPage />,
      },
      {
        path: 'orders/:publicOrderNumber/checkout-cancelled',
        element: <CheckoutCancelledPage />,
      },
      {
        path: 'orders/:publicOrderNumber/status',
        element: <OrderStatusPage />,
      },
      {
        path: '*',
        element: <NotFoundPage />,
      },
    ],
  },
];

export const router = createBrowserRouter(routes);
