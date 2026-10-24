import { type VariantProps } from "class-variance-authority";
import { Separator } from "@/components/ui/separator";
declare const buttonGroupVariants: any;
declare function ButtonGroup({ className, orientation, ...props }: React.ComponentProps<"div"> & VariantProps<typeof buttonGroupVariants>): any;
declare function ButtonGroupText({ className, asChild, ...props }: React.ComponentProps<"div"> & {
    asChild?: boolean;
}): any;
declare function ButtonGroupSeparator({ className, orientation, ...props }: React.ComponentProps<typeof Separator>): any;
export { ButtonGroup, ButtonGroupSeparator, ButtonGroupText, buttonGroupVariants, };
//# sourceMappingURL=button-group.d.ts.map