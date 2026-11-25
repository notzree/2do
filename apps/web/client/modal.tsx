import { useEffect, useRef, type ReactNode } from "react";

export function Modal({
	title,
	close,
	children,
	alert = false,
}: {
	title: string;
	close: () => void;
	children: ReactNode;
	alert?: boolean;
}) {
	const ref = useRef<HTMLDialogElement>(null);
	useEffect(() => {
		const dialog = ref.current!;
		dialog.showModal();
		return () => dialog.close();
	}, []);
	return (
		<dialog
			ref={ref}
			aria-label={title}
			role={alert ? "alertdialog" : undefined}
			onCancel={(event) => {
				event.preventDefault();
				close();
			}}
		>
			<div className="section-head">
				<h2>{title}</h2>
				<button className="plain" onClick={close} aria-label="Close dialog">
					Close
				</button>
			</div>
			{children}
		</dialog>
	);
}
