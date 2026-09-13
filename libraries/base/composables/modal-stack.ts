import type { Component } from "vue";
import ConfirmationModal from "../components/ConfirmationModal.vue";
import NotificationModal from "../components/NotificationModal.vue";
import TextInputModal from "../components/TextInputModal.vue";

export type ModalCallbackType<T extends ModalType> = (
  event: ModalEvents[T],
  close: () => void,
  ...args: unknown[]
) => Promise<void> | void;

/** Erased callback shape stored in the heterogeneous modal stack. */
export type ModalCallback = (
  event: string,
  close: () => void,
  ...args: unknown[]
) => Promise<void> | void;

export interface ModalStackElement {
  component: Component;
  type: ModalType;
  callback: ModalCallback;
  loading: Ref<boolean>;
  data: ModalDataMap[ModalType];
}

export enum ModalType {
  Confirmation,
  Notification,
  TextInput,
}

export type ModalEvents = {
  [ModalType.Confirmation]: "confirm" | "cancel";
  [ModalType.Notification]: "close";
  [ModalType.TextInput]: "cancel" | "submit";
};

export type ModalDataMap = {
  [ModalType.Confirmation]: {
    title: string;
    description: string;
    buttonText?: string;
  };
  [ModalType.Notification]: {
    title: string;
    description: string;
    buttonText?: string;
  };
  [ModalType.TextInput]: {
    title: string;
    description: string;
    buttonText?: string;
    dft?: string;
    placeholder?: string;
  };
};

const modalComponents: { [key in ModalType]: Component } = {
  [ModalType.Confirmation]: ConfirmationModal,
  [ModalType.Notification]: NotificationModal,
  [ModalType.TextInput]: TextInputModal,
};

export function createModal<T extends ModalType>(
  type: T,
  data: ModalDataMap[T],
  callback: ModalCallbackType<T>,
) {
  const modalStack = useModalStack();
  modalStack.value.push({
    type,
    component: modalComponents[type],
    // The owning component invokes the callback with its own event union.
    callback: callback as ModalCallback,
    data,
    loading: ref(false),
  });
}

export const useModalStack = () =>
  useState<Array<ModalStackElement>>("modal-stack", () => []);
