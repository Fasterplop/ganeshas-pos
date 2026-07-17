// usePOSStore.ts
import { create } from 'zustand';

export interface Store {
  id: string;
  name: string;
  is_active: boolean;
}

export interface CartItem {
  id: string;
  name: string;
  price: number;
  quantity: number;
  talla?: string | null;
  color?: string | null;
}

interface POSState {
  // --- Nueva Lógica de Tienda ---
  currentStore: Store | null;
  setCurrentStore: (store: Store | null) => void;

  bcvRate: number;
  setBcvRate: (rate: number) => void;
  
  cart: CartItem[];
  addToCart: (item: CartItem) => void;
  removeFromCart: (id: string) => void;
  clearCart: () => void;
}

export const usePOSStore = create<POSState>((set) => ({
  currentStore: null,
  // Al cambiar de tienda, vaciamos el carrito por seguridad
  setCurrentStore: (store) => set({ 
    currentStore: store, 
    cart: [] 
  }),

  bcvRate: 0,
  setBcvRate: (rate) => set({ bcvRate: rate }),

  cart: [],
  addToCart: (item) => 
    set((state) => {
      const existingItem = state.cart.find((i) => i.id === item.id);
      if (existingItem) {
        return {
          cart: state.cart.map((i) =>
            i.id === item.id ? { ...i, quantity: i.quantity + item.quantity } : i
          ),
        };
      }
      return { cart: [...state.cart, item] };
    }),
  removeFromCart: (id) =>
    set((state) => ({ cart: state.cart.filter((i) => i.id !== id) })),
  clearCart: () => set({ cart: [] }),
}));