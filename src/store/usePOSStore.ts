import { create } from 'zustand';

// Definimos cómo se ve un producto en el carrito
export interface CartItem {
  id: string; // Product ID
  name: string;
  price: number;
  quantity: number;
}

// Definimos todo lo que guardará nuestro Store
interface POSState {
  bcvRate: number;
  setBcvRate: (rate: number) => void;
  
  cart: CartItem[];
  addToCart: (item: CartItem) => void;
  removeFromCart: (id: string) => void;
  clearCart: () => void;
}

export const usePOSStore = create<POSState>((set) => ({
  // 1. Estado inicial de la Tasa (0 significa que no se ha configurado)
  bcvRate: 0,
  setBcvRate: (rate) => set({ bcvRate: rate }),

  // 2. Estado del Carrito
  cart: [],
  addToCart: (item) => 
    set((state) => {
      // Si el producto ya está, sumamos la cantidad
      const existingItem = state.cart.find((i) => i.id === item.id);
      if (existingItem) {
        return {
          cart: state.cart.map((i) =>
            i.id === item.id ? { ...i, quantity: i.quantity + item.quantity } : i
          ),
        };
      }
      // Si no está, lo agregamos nuevo
      return { cart: [...state.cart, item] };
    }),
  removeFromCart: (id) =>
    set((state) => ({ cart: state.cart.filter((i) => i.id !== id) })),
  clearCart: () => set({ cart: [] }),
}));