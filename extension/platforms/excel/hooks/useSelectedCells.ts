/// <reference types="office-js" />
import type { InputBarHostSelection } from "@app/components/assistant/conversation/input_bar/InputBarContext";
import { MicrosoftExcelLogo } from "@dust-tt/sparkle";
import { useEffect, useMemo, useState } from "react";

// Returns the address of the selected cells with the sheet name, e.g. "Sheet1!C11" or
// "'My sheet'!A1:B4". Returns null when the selection is not one range, e.g. a chart, a shape or
// several ranges: Office.js then fails to give the selected range.
async function getSelectedAddress(): Promise<string | null> {
  try {
    return await Excel.run(async (context) => {
      const range = context.workbook.getSelectedRange();
      range.load("address");
      await context.sync();
      return range.address;
    });
  } catch {
    return null;
  }
}

function useSelectedAddress(): string | null {
  const [selectedAddress, setSelectedAddress] = useState<string | null>(null);

  useEffect(() => {
    // Office.js adds the handler only after a round trip to Excel, and ignores a removal sent
    // before it (e.g. under StrictMode): a removed handler must then do nothing.
    let isSubscribed = true;
    const updateSelectedAddress = async () => {
      if (!isSubscribed) {
        return;
      }
      const address = await getSelectedAddress();
      if (isSubscribed) {
        setSelectedAddress(address);
      }
    };

    void updateSelectedAddress();
    Office.context.document.addHandlerAsync(
      Office.EventType.DocumentSelectionChanged,
      updateSelectedAddress
    );
    return () => {
      isSubscribed = false;
      Office.context.document.removeHandlerAsync(
        Office.EventType.DocumentSelectionChanged,
        { handler: updateSelectedAddress }
      );
    };
  }, []);

  return selectedAddress;
}

export function useSelectedCells(): InputBarHostSelection | null {
  const address = useSelectedAddress();

  // A removed selection stays hidden until the selection changes.
  const [isRemoved, setIsRemoved] = useState(false);
  const [prevAddress, setPrevAddress] = useState(address);
  if (address !== prevAddress) {
    setPrevAddress(address);
    setIsRemoved(false);
  }

  return useMemo(
    () =>
      address && !isRemoved
        ? {
            label: address,
            icon: MicrosoftExcelLogo,
            onRemove: () => setIsRemoved(true),
          }
        : null,
    [address, isRemoved]
  );
}
